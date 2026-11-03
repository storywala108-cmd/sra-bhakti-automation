// Renders each design block of brand.html to a PNG with headless Chrome (one page per design).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const html = fs.readFileSync(path.join(__dirname, 'brand.html'), 'utf8');
for (const [id, w, h] of [['profile', 1080, 1080], ['cover', 1640, 856]]) {
  const page = html.replace('</style>', `body>div{display:none} #${id}{display:block!important}</style>`);
  const f = path.join(__dirname, `_${id}.html`);
  fs.writeFileSync(f, page);
  const out = path.resolve(__dirname, '..', `sra_${id}.png`);
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--window-size=${w},${h}`, `--screenshot=${out}`, '--virtual-time-budget=3000', pathToFileURL(f).href], { stdio: 'ignore' });
  fs.unlinkSync(f);
  console.log(id, fs.existsSync(out) ? 'ok' : 'FAILED');
}
