// Assemble a video from preview/script.json: per-scene TTS, Ken Burns on the lithographs, the map clip,
// crossfades, paper grain, music bed ducked under the voice, -14 LUFS.
// Usage: node scripts/assemble.js <dir> [voice=Charon] [music.mp3] [w=1280] [h=720] [musicStartSec=0]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tts, log } from './lib.js';

const [dir, voice = 'Charon', music, W = '1280', H = '720', MSTART = '0'] = process.argv.slice(2);
const FPS = 30, XF = 0.5, GAP = 0.35;
const s = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'));
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const dur = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const frames = sec => Math.round(sec * FPS);           // whole frames only (lesson 2026-10-24)

// 1) voice, scene by scene (3 at a time), so every scene's length is exact
for (let i = 0; i < s.scenes.length; i += 3) {
  await Promise.all(s.scenes.slice(i, i + 3).map(async (sc, k) => {
    const f = path.join(dir, `vo${i + k}.wav`);
    if (!fs.existsSync(f)) await tts(sc.text, f, { voice });
  }));
}
s.scenes.forEach((sc, i) => { sc.vo = dur(path.join(dir, `vo${i}.wav`)); });
log('voice', s.scenes.map(x => x.vo.toFixed(1)).join(' '));

// 2) one clip per scene; each lasts its voice + gap (+ crossfade overlap)
const SET = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
s.scenes.forEach((sc, i) => {
  const len = frames(sc.vo + GAP + (i < s.scenes.length - 1 ? XF : 0)) / FPS;
  sc.len = len;
  const out = path.join(dir, `clip${i}.mp4`);
  if (sc.visual === 'map') {
    ff(['-framerate', String(FPS), '-i', path.join(dir, 'map', 'f%04d.png'),
      '-vf', `scale=${W}:${H},tpad=stop_mode=clone:stop_duration=30,trim=duration=${len},format=yuv420p,${SET}`,
      '-r', String(FPS), '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', out]);
    return;
  }
  // alternate push-in / pull-out / drift so no two neighbours move the same way
  const n = frames(len), moves = [
    `z='1.0+0.12*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `z='1.12-0.12*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `z='1.1':x='(iw-iw/zoom)*on/${n}':y='ih/2-(ih/zoom/2)'`,
    `z='1.1':x='(iw-iw/zoom)*(1-on/${n})':y='(ih-ih/zoom)*0.3'`,
  ];
  ff(['-loop', '1', '-i', path.join(dir, `img${i}.jpg`),
    '-vf', `scale=${W * 2}:${H * 2}:out_color_matrix=bt709,zoompan=${moves[i % moves.length]}:d=${n}:s=${W}x${H}:fps=${FPS},format=yuv420p,${SET}`,
    '-frames:v', String(n), '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', out]);
});
log('clips', s.scenes.length);

// 3) crossfade chain + warm grain/vignette
const inputs = s.scenes.flatMap((_, i) => ['-i', path.join(dir, `clip${i}.mp4`)]);
let chain = '', last = '[0:v]', t = 0;
for (let i = 1; i < s.scenes.length; i++) {
  t += s.scenes[i - 1].len - XF;
  chain += `${last}[${i}:v]xfade=transition=fade:duration=${XF}:offset=${t.toFixed(3)}[v${i}];`;
  last = `[v${i}]`;
}
// static grain only: temporal noise (allf=t) flickers like TV snow
chain += `${last}noise=alls=4,vignette=PI/5,format=yuv420p,${SET}[vout]`;
ff([...inputs, '-filter_complex', chain, '-map', '[vout]', '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', path.join(dir, 'video.mp4')]);

// 4) voice track: each scene's VO starts where its clip starts
const starts = []; t = 0;
s.scenes.forEach((sc, i) => { starts.push(t + 0.15); t += sc.len - (i < s.scenes.length - 1 ? XF : 0); });
const total = dur(path.join(dir, 'video.mp4'));
const vin = s.scenes.flatMap((_, i) => ['-i', path.join(dir, `vo${i}.wav`)]);
const vmix = s.scenes.map((_, i) => `[${i}:a]aresample=48000,adelay=${Math.round(starts[i] * 1000)}|${Math.round(starts[i] * 1000)}[a${i}]`).join(';') +
  `;${s.scenes.map((_, i) => `[a${i}]`).join('')}amix=inputs=${s.scenes.length}:normalize=0,apad,atrim=0:${total.toFixed(3)}[vo]`;
ff([...vin, '-filter_complex', vmix, '-map', '[vo]', '-ac', '2', path.join(dir, 'voice.wav')]);

// 5) cinematic music bed: both tracks loudness-matched first, music kept ~12-14 dB under the voice while he
// talks (gentle duck) and swelling in the gaps (feedback 2026-11-01: louder, "dumdaar" cinematic bed).
const mix = path.join(dir, 'mix.wav');
if (music) {
  ff(['-i', path.join(dir, 'voice.wav'), '-ss', MSTART, '-stream_loop', '-1', '-i', music, '-filter_complex',
    `[0:a]loudnorm=I=-16:TP=-2:LRA=7,aresample=48000[vn];` +
    `[1:a]aresample=48000,loudnorm=I=-16:TP=-2,volume=-9dB,atrim=0:${total.toFixed(3)},afade=t=in:d=1.2,afade=t=out:st=${(total - 3).toFixed(3)}:d=3[m];` +
    `[vn]asplit[v1][v2];[m][v1]sidechaincompress=threshold=0.05:ratio=2.5:attack=40:release=600[md];` +
    `[v2][md]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[out]`, '-map', '[out]', '-ar', '48000', mix]);
} else {
  ff(['-i', path.join(dir, 'voice.wav'), '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', mix]);
}
const final = path.join(dir, 'preview.mp4');
ff(['-i', path.join(dir, 'video.mp4'), '-i', mix, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', final + '.tmp.mp4']);
fs.renameSync(final + '.tmp.mp4', final);
log('done', final, total.toFixed(1) + 's');
