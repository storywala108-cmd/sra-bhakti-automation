// Shorts from a finished long video (asked 2026-11-01): AI picks self-contained moments, each is cut from
// final.mp4 and rebuilt vertically (1080×1920): blurred fill, the lithograph shot in the middle, a big hook on top,
// timed captions under it and a "full story on Ink & Crowns" tag. Posted on days without a new long video.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, aiJson, log } from './lib.js';

const ff = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const assTime = t => { const cs = Math.max(0, Math.round(t * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
const assEsc = s => String(s).replace(/[{}\\]/g, '').replace(/\n/g, ' ');

// scenes: [{text, start, vo}] on the final video's timeline
export async function makeShorts(dir, script, scenes, count = 4) {
  const list = scenes.map((s, i) => `[${i}] (${s.vo.toFixed(1)}s) ${s.text}`).join('\n');
  const { data } = await aiJson(
    `These are the narrated scenes of a history video "${script.pack.title}" (index, seconds, text):\n${list.slice(0, 12000)}\n\n` +
    `Pick ${count} YouTube Shorts. Each = a run of CONSECUTIVE scenes totalling 40-58 seconds that makes sense on ` +
    `its own, starts on a strong line and ends on a punch or open question that makes people want the full video. ` +
    `No overlaps. For each give a hook for the top of the screen (max 7 words, curiosity, true to the clip) and a ` +
    `Shorts title (max 70 chars, no clickbait lies).\nReturn JSON {"shorts":[{"from":first index,"to":last index,"hook":"...","title":"..."}]}`,
    { check: d => { if (!d.shorts?.length) throw new Error('no shorts'); return d; }, temperature: 0.6 },
  );
  // same honesty rule as the long video: titles/hooks must be supported by the clip (first batch said
  // "Illegal deal" and "Patton's Rogue rescue", which the script never claimed)
  const clipText = sh => scenes.slice(Number(sh.from), Number(sh.to) + 1).map(s => s.text).join(' ');
  const fix = await aiJson(
    `Check each YouTube Short's title and hook against what its clip actually says and against real history. ` +
    `Keep curiosity, remove anything invented or exaggerated (illegal, rogue, secret, numbers not in the clip…).\n` +
    JSON.stringify(data.shorts.map((sh, i) => ({ i, title: sh.title, hook: sh.hook, clip: clipText(sh).slice(0, 1500) }))) +
    `\nReturn JSON {"shorts":[{"i":0,"title":"honest title max 70 chars","hook":"honest hook max 7 words"}]}`,
    { check: d => { if (!d.shorts?.length) throw new Error('no fixes'); return d; }, temperature: 0.3 },
  ).catch(() => null);
  for (const f of fix?.data?.shorts || []) if (data.shorts[f.i] && f.title) Object.assign(data.shorts[f.i], { title: f.title, hook: f.hook || data.shorts[f.i].hook });
  const out = [];
  for (const [k, sh] of data.shorts.slice(0, count).entries()) {
    let a = Math.max(0, Math.min(scenes.length - 1, Number(sh.from))), b = Math.max(a, Math.min(scenes.length - 1, Number(sh.to)));
    // keep it inside YouTube's comfort zone: trim scenes from the end while > 59 s
    while (b > a && scenes[b].start + scenes[b].vo - scenes[a].start > 59) b--;
    const start = scenes[a].start, dur = Math.min(59, scenes[b].start + scenes[b].vo + 0.6 - start);
    if (dur < 20) continue;
    // captions: each scene's words in chunks of 4, spread over that scene's spoken time
    const ev = [];
    for (let i = a; i <= b; i++) {
      const words = scenes[i].text.split(/\s+/), chunks = [];
      for (let w = 0; w < words.length; w += 4) chunks.push(words.slice(w, w + 4).join(' '));
      const t0 = scenes[i].start - start + 0.15, per = (scenes[i].vo - 0.2) / chunks.length;
      chunks.forEach((c, j) => ev.push(`Dialogue: 0,${assTime(t0 + j * per)},${assTime(t0 + (j + 1) * per)},Cap,,0,0,0,,${assEsc(c)}`));
    }
    // hook: big yellow, wraps to 2 lines (WrapStyle 0); captions under the picture
    const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\n` +
      `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
      `Style: Hook,Anton,124,&H0040CDFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,8,3,8,80,80,200,1\n` +
      `Style: Cap,Anton,88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,7,2,8,80,80,1290,1\n` +
      `Style: Tag,Anton,46,&H009CDCF3,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,3,0,1,4,1,2,60,60,150,1\n\n` +
      `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
      `Dialogue: 1,0:00:00.00,${assTime(dur)},Hook,,0,0,0,,${assEsc(sh.hook).toUpperCase()}\n` + ev.join('\n') + '\n' +
      `Dialogue: 1,0:00:00.00,${assTime(dur)},Tag,,0,0,0,,FULL STORY ON INK & CROWNS ▶\n`;
    const assF = path.join(dir, `short${k}.ass`);
    fs.writeFileSync(assF, ass);
    const outF = path.join(dir, `short${k}.mp4`);
    // run ffmpeg from the project root so the subtitles filter gets short relative paths (no drive-letter escaping)
    const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', start.toFixed(2), '-t', dur.toFixed(2), '-i', rel(path.join(dir, 'final.mp4')), '-filter_complex',
      `[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.25[bg];` +
      `[b]scale=1080:-2[fg];[bg][fg]overlay=0:(H-h)/2-80,subtitles=${rel(assF)}:fontsdir=fonts,` +
      `setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[v]`,
      '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k',
      '-af', 'afade=t=out:st=' + (dur - 0.8).toFixed(2) + ':d=0.8', '-movflags', '+faststart', rel(outF + '.tmp.mp4')], { cwd: ROOT, stdio: 'inherit' });
    fs.renameSync(outF + '.tmp.mp4', outF);
    out.push({ file: `short${k}.mp4`, title: String(sh.title).slice(0, 90), hook: sh.hook, start, dur });
    log(`short ${k + 1}: ${dur.toFixed(0)} s — ${sh.title}`);
  }
  fs.writeFileSync(path.join(dir, 'shorts.json'), JSON.stringify(out, null, 2));
  return out;
}
