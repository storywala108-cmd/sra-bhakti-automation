// Long-form renderer: per-scene clips (Ken Burns / map), chapter title cards, grouped crossfades,
// Devanagari subtitles + chapter cards (ASS via libass = proper Hindi shaping), soft grain, music bed under the
// voice, -14 LUFS, preflight checks.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT, log } from './lib.js';

// GAP 0: scene cuts often fall mid-sentence; an added pause there made the voice sound stuck (owner, 2026-11-03)
const FPS = 30, XF = 0.5, GAP = 0, W = 1920, H = 1080;
const SET = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
const ff = (args, cwd) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit', cwd });
export const dur = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const frames = sec => Math.round(sec * FPS);
const SUBS = String(process.env.SUBTITLES ?? 'true') !== 'false';

// ASS subtitle file: chapter cards (Tiro Devanagari) + Hindi subtitles (Mukta ExtraBold, yellow like the niche).
// FFmpeg drawtext can't shape Devanagari; libass (HarfBuzz) can.
const assTime = t => { const cs = Math.max(0, Math.round(t * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
const assText = t => String(t).replace(/[{}\\]/g, '').replace(/\n/g, ' ');
function writeAss(file, scenes, starts) {
  const ev = [];
  scenes.forEach((sc, i) => {
    if (sc.chapterTitle) ev.push(`Dialogue: 1,${assTime(sc.start + 0.3)},${assTime(sc.start + 4.2)},Chapter,,0,0,0,,{\\fad(500,500)}${assText(sc.chapterTitle)}`);
    if (!SUBS) return;
    // 2-line max chunks of ~7 words, timed by their share of the scene's characters
    const words = sc.text.split(/\s+/).filter(Boolean), chunks = [];
    for (let k = 0; k < words.length; k += 7) chunks.push(words.slice(k, k + 7).join(' '));
    if (chunks.length > 1 && chunks.at(-1).split(' ').length < 3) chunks.splice(-2, 2, chunks.at(-2) + ' ' + chunks.at(-1));
    const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let t = starts[i];
    for (const c of chunks) {
      const d = sc.vo * c.length / total;
      ev.push(`Dialogue: 0,${assTime(t)},${assTime(t + d)},Sub,,0,0,0,,${assText(c)}`);
      t += d;
    }
  });
  fs.writeFileSync(file, `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Sub,Mukta ExtraBold,62,&H0000D8FF,&H0000D8FF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,4,2,2,120,120,60,1\n` +
    `Style: Chapter,Tiro Devanagari Hindi,84,&H00D6F3FF,&H00D6F3FF,&H00101A2A,&HA0101020,0,0,0,0,100,100,0,0,3,18,0,5,100,100,0,1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${ev.join('\n')}\n`);
}

// scenes: [{text, visual, img, mapDir, vo, chapterTitle?}] ; returns timings
export function renderVideo(scenes, dir, { musicFiles = [], vcodec = ['libx264', '-preset', 'veryfast', '-crf', '20'] } = {}) {
  const clipsDir = path.join(dir, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });
  scenes.forEach((sc, i) => {
    sc.len = frames(sc.vo + GAP + (i < scenes.length - 1 ? XF : 0)) / FPS;
    const out = path.join(clipsDir, `c${String(i).padStart(3, '0')}.mp4`);
    if (fs.existsSync(out)) return;
    const n = frames(sc.len);
    const card = '';
    if (sc.visual === 'map' && sc.mapDir) {
      ff(['-framerate', String(FPS), '-i', path.join(sc.mapDir, 'f%04d.png'),
        '-vf', `scale=${W}:${H},tpad=stop_mode=clone:stop_duration=60,trim=duration=${sc.len}${card},format=yuv420p,${SET}`,
        '-r', String(FPS), '-c:v', ...vcodec, out + '.tmp.mp4']);
    } else {
      const moves = [
        `z='1.0+0.12*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
        `z='1.12-0.12*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
        `z='1.1':x='(iw-iw/zoom)*on/${n}':y='ih/2-(ih/zoom/2)'`,
        `z='1.1':x='(iw-iw/zoom)*(1-on/${n})':y='(ih-ih/zoom)*0.3'`,
        `z='1.0+0.08*on/${n}':x='(iw-iw/zoom)*0.2':y='(ih-ih/zoom)*(1-on/${n})'`,
      ];
      ff(['-loop', '1', '-i', sc.img, '-vf',
        `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase:out_color_matrix=bt709,crop=${W * 2}:${H * 2},` +
        `zoompan=${moves[i % moves.length]}:d=${n}:s=${W}x${H}:fps=${FPS}${card},format=yuv420p,${SET}`,
        '-frames:v', String(n), '-c:v', ...vcodec, out + '.tmp.mp4']);
    }
    fs.renameSync(out + '.tmp.mp4', out);
    if (i % 10 === 0) log(`clip ${i + 1}/${scenes.length}`);
  });

  // crossfades in groups of 12 (one giant xfade graph with 90 inputs is slow and memory hungry)
  const clip = i => path.join(clipsDir, `c${String(i).padStart(3, '0')}.mp4`);
  const xfadeChain = (files, lens, out) => {
    if (files.length === 1) { fs.copyFileSync(files[0], out); return; }
    let chain = '', last = '[0:v]', t = 0;
    for (let i = 1; i < files.length; i++) {
      t += lens[i - 1] - XF;
      chain += `${last}[${i}:v]xfade=transition=fade:duration=${XF}:offset=${t.toFixed(3)}[v${i}];`;
      last = `[v${i}]`;
    }
    ff([...files.flatMap(f => ['-i', f]), '-filter_complex', chain.slice(0, -1).replace(/\[v\d+\]$/, '') + '[vout]',
      '-map', '[vout]', '-c:v', ...vcodec, out]);
  };
  const groups = [];
  for (let g = 0; g * 12 < scenes.length; g++) {
    const idx = scenes.map((_, i) => i).slice(g * 12, g * 12 + 12);
    const out = path.join(clipsDir, `g${g}.mp4`);
    if (!fs.existsSync(out)) xfadeChain(idx.map(clip), idx.map(i => scenes[i].len), out);
    groups.push(out);
  }
  const video = path.join(dir, 'video.mp4');
  xfadeChain(groups, groups.map(dur), path.join(dir, 'video_raw.mp4'));

  // voice placement: scene i starts where its clip starts
  const starts = []; let t = 0;
  scenes.forEach((sc, i) => { starts.push(t + 0.15); sc.start = t; t += sc.len - (i < scenes.length - 1 ? XF : 0); });
  writeAss(path.join(dir, 'subs.ass'), scenes, starts);
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'fonts')).filter(f => f.endsWith('.ttf'))) fs.copyFileSync(path.join(ROOT, 'fonts', f), path.join(dir, 'fonts', f));
  // relative paths + cwd = no Windows drive-letter escaping inside the filter
  ff(['-i', 'video_raw.mp4', '-vf', `noise=alls=3,vignette=PI/6,subtitles=subs.ass:fontsdir=fonts,format=yuv420p,${SET}`, '-c:v', ...vcodec, 'video.mp4'], dir);

  const total = dur(video);
  const list = path.join(dir, 'vo_list.txt');
  // build the voice track by padding each clip to its slot, then concat (no 90-input amix)
  scenes.forEach((sc, i) => {
    const slot = (i < scenes.length - 1 ? starts[i + 1] : total) - starts[i];
    ff(['-i', sc.voFile, '-af', `aresample=48000,apad,atrim=0:${slot.toFixed(3)}`, '-ac', '1', path.join(dir, 'clips', `a${i}.wav`)]);
  });
  fs.writeFileSync(list, `file 'silence.wav'\n` + scenes.map((_, i) => `file 'clips/a${i}.wav'`).join('\n'));
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(starts[0]), path.join(dir, 'silence.wav')]);
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', path.join(dir, 'voice.wav')]);

  // music bed: shuffled tracks chained with 3 s crossfades until the video is covered
  const mix = path.join(dir, 'mix.wav');
  if (musicFiles.length) {
    const bed = []; let covered = 0;
    while (covered < total + 5) { const f = musicFiles[bed.length % musicFiles.length]; bed.push(f); covered += dur(f) - 3; }
    let g = bed.map((_, i) => `[${i + 1}:a]aresample=48000,loudnorm=I=-16:TP=-2[m${i}]`).join(';') + ';';
    let lastM = '[m0]';
    for (let i = 1; i < bed.length; i++) { g += `${lastM}[m${i}]acrossfade=d=3[x${i}];`; lastM = `[x${i}]`; }
    g += `${lastM}volume=-13dB,atrim=0:${total.toFixed(3)},afade=t=in:d=1.2,afade=t=out:st=${(total - 4).toFixed(3)}:d=4[m];` +
      `[0:a]loudnorm=I=-16:TP=-2:LRA=7,aresample=48000,asplit[v1][v2];[m][v1]sidechaincompress=threshold=0.05:ratio=2.5:attack=40:release=600[md];` +
      `[v2][md]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[out]`;
    ff(['-i', path.join(dir, 'voice.wav'), ...bed.flatMap(f => ['-i', f]), '-filter_complex', g, '-map', '[out]', '-ac', '2', '-ar', '48000', mix]);
  } else {
    ff(['-i', path.join(dir, 'voice.wav'), '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ac', '2', '-ar', '48000', mix]);
  }
  const final = path.join(dir, 'final.mp4');
  ff(['-i', video, '-i', mix, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', final + '.tmp.mp4']);
  fs.renameSync(final + '.tmp.mp4', final);
  return { final, total, starts: scenes.map(s => s.start) };
}

// Never upload a broken file: length, streams, loudness, no static bursts.
export function preflight(file, expectSec) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  const v = probe.streams.find(s => s.codec_type === 'video'), a = probe.streams.find(s => s.codec_type === 'audio');
  const d = Number(probe.format.duration);
  const problems = [];
  if (!v || v.width !== W || v.height !== H) problems.push('video stream/size');
  if (!a) problems.push('no audio');
  if (Math.abs(d - expectSec) > 3) problems.push(`duration ${d.toFixed(1)} vs ${expectSec.toFixed(1)}`);
  const lufs = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const I = Number((lufs.match(/I:\s+(-?[\d.]+) LUFS/g) || []).pop()?.match(/-?[\d.]+/)[0]);
  if (!(I > -16.5 && I < -12)) problems.push(`loudness ${I}`);
  return { ok: !problems.length, problems, duration: d, lufs: I };
}
