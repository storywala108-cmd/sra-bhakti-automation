// YouTube thumbnail 1280x720: bright AI scene + big bold Hindi hook text, rendered by headless Chrome
// (PIL/FFmpeg can't shape Devanagari). Thumbnail rules: heavy bold text (Noto Sans Devanagari 900, white with
// shadow + one accent line in yellow on a dark brush box), always inside the frame, layout varied per video.
// Usage: node scripts/thumb.js <bg.jpg> <out.jpg> "<text>" [left|right]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.js';

const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']
  .find(p => p && fs.existsSync(p));

export function makeThumb(bg, out, text, side = 'right') {
  const words = String(text).replace(/\s+/g, ' ').trim();
  // split into a white line + an accent line (the last 1-2 words, or what follows "…")
  let [l1, l2] = words.includes('…') ? words.split('…').map((x, i) => i ? x : x + '…') : [null, null];
  if (!l2) { const w = words.split(' '); const k = Math.max(1, w.length - (w.length > 3 ? 2 : 1)); l1 = w.slice(0, k).join(' '); l2 = w.slice(k).join(' '); }
  const font = pathToFileURL(path.join(ROOT, 'fonts', 'NotoSansDevanagari-Variable.ttf')).href;
  const align = side === 'left' ? 'left:56px' : 'right:56px';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:N;src:url(${font});font-weight:100 900}
*{margin:0;box-sizing:border-box}html,body{width:1280px;height:720px;overflow:hidden;background:#000}
.bg{position:absolute;inset:0;background:url(${pathToFileURL(bg).href}) center/cover;filter:saturate(1.35) contrast(1.08) brightness(1.05)}
.shade{position:absolute;inset:0;background:linear-gradient(${side === 'left' ? '90deg' : '270deg'},rgba(0,0,0,.55),rgba(0,0,0,0) 55%)}
.box{position:absolute;${align};bottom:60px;max-width:640px;text-align:center;font-family:N;font-weight:900}
.l1{color:#fff;font-size:86px;line-height:1.12;text-shadow:0 5px 0 #000,0 0 22px rgba(0,0,0,.9)}
.l2{display:inline-block;margin-top:10px;padding:6px 28px 14px;background:#111;border-radius:14px;transform:rotate(-2deg);
color:#ffd21f;font-size:96px;line-height:1.1;box-shadow:0 8px 24px rgba(0,0,0,.6)}
</style></head><body><div class="bg"></div><div class="shade"></div>
<div class="box" id="b"><div class="l1">${l1}</div><div class="l2">${l2}</div></div>
<script>
// shrink until the text block fits inside the frame with margins
const b=document.getElementById('b');let s=1;
while((b.offsetHeight>600||b.scrollWidth>660)&&s>0.4){s-=0.05;b.style.fontSize='';b.querySelector('.l1').style.fontSize=86*s+'px';b.querySelector('.l2').style.fontSize=96*s+'px';}
</script></body></html>`;
  const f = out + '.html';
  fs.writeFileSync(f, html);
  const png = out.replace(/\.\w+$/, '') + '_raw.png';
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--no-sandbox',
    '--window-size=1280,720', `--screenshot=${png}`, '--virtual-time-budget=3000', pathToFileURL(f).href], { stdio: 'ignore' });
  fs.unlinkSync(f);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-q:v', '2', out]);
  fs.unlinkSync(png);
  return out;
}

if (process.argv[1]?.endsWith('thumb.js')) {
  const [bg, out, text, side] = process.argv.slice(2);
  makeThumb(bg, out, text, side);
  console.log('thumb', out);
}
