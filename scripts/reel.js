// Instagram reel cut from the long video (owner 2026-11-03: Facebook gets the full video, Instagram a cut reel).
// 1080x1920: blurred fill, the 16:9 picture (with its Hindi subtitles) in the middle, the thumbnail hook on top,
// "पूरी कथा …" at the bottom. Takes the cold open + following scenes up to IG_MAX seconds, cut at a scene boundary.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, log } from './lib.js';

const IG_MAX = 44.5;   // the IG API failed above ~45 s on every account so far
const assTime = t => { const cs = Math.max(0, Math.round(t * 100)); return `0:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
const clean = t => String(t).replace(/[{}\\]/g, '');

export function makeReel(dir, sceneTimes, hook) {
  const final = path.join(dir, 'final.mp4');
  // end at the last scene that finishes before IG_MAX (at least 20 s)
  let end = 0;
  for (const s of sceneTimes) { const e = s.start + s.vo; if (e <= IG_MAX - 0.6) end = e; else break; }
  if (end < 20) end = IG_MAX - 0.6;
  end = Math.round((end + 0.4) * 30) / 30;
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'fonts')).filter(f => f.endsWith('.ttf'))) fs.copyFileSync(path.join(ROOT, 'fonts', f), path.join(dir, 'fonts', f));
  // big captions under the picture (the 16:9 picture's own subtitles are too small on a phone)
  const caps = [];
  for (const s of sceneTimes) {
    if (s.start >= end) break;
    const words = s.text.split(/\s+/).filter(Boolean), chunks = [];
    for (let k = 0; k < words.length; k += 5) chunks.push(words.slice(k, k + 5).join(' '));
    if (chunks.length > 1 && chunks.at(-1).split(' ').length < 3) chunks.splice(-2, 2, chunks.at(-2) + ' ' + chunks.at(-1));
    const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let t = s.start;
    for (const c of chunks) { const d = s.vo * c.length / total; if (t < end) caps.push(`Dialogue: 0,${assTime(t)},${assTime(Math.min(end, t + d))},Cap,,0,0,0,,${clean(c)}`); t += d; }
  }
  fs.writeFileSync(path.join(dir, 'reel.ass'), `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `Style: Hook,Mukta ExtraBold,112,&H0000D8FF,&H0000D8FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,8,3,8,60,60,300,1\n` +
    `Style: Cap,Mukta ExtraBold,76,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,6,2,8,70,70,1330,1\n` +
    `Style: Foot,Mukta ExtraBold,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,5,2,2,60,60,260,1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    `Dialogue: 0,${assTime(0)},${assTime(end)},Hook,,0,0,0,,${clean(hook)}\n` + caps.join('\n') + '\n' +
    `Dialogue: 0,${assTime(0)},${assTime(end)},Foot,,0,0,0,,पूरी कथा देखें — YouTube पर SRA@Bhakti Channel\n`);
  const g = `[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:3,eq=brightness=-0.15[bg];` +
    `[b]scale=1080:-2[fg];[bg][fg]overlay=0:(H-h)/2,subtitles=reel.ass:fontsdir=fonts,format=yuv420p[v];` +
    `[0:a]afade=t=out:st=${(end - 0.8).toFixed(2)}:d=0.8[au]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-t', end.toFixed(3), '-i', 'final.mp4', '-filter_complex', g, '-map', '[v]', '-map', '[au]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'reel.tmp.mp4'],
    { cwd: dir, stdio: 'inherit' });
  fs.renameSync(path.join(dir, 'reel.tmp.mp4'), path.join(dir, 'reel.mp4'));
  log(`instagram reel: ${end.toFixed(1)} s`);
  return { file: 'reel.mp4', seconds: end };
}
