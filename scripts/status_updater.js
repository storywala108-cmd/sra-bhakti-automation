// Laptop-only helper: every minute writes the newest pipeline log lines into STATUS.html (the panel auto-refreshes).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.js';

const page = path.join(ROOT, 'STATUS.html');
const logf = path.join(ROOT, 'logs', 'sample.log');
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function tick() {
  if (!fs.existsSync(logf) || !fs.existsSync(page)) return;
  const lines = fs.readFileSync(logf, 'utf8').split(/\r?\n/).filter(Boolean).slice(-6).map(esc).join('<br>');
  const block = `<!--live--><div style="margin-top:12px;background:#fff;border-radius:8px;padding:10px 12px;font:12px/1.5 Consolas,monospace;color:#5a4a00"><b>Live (${new Date().toLocaleTimeString('en-IN')})</b><br>${lines}</div><!--/live-->`;
  let s = fs.readFileSync(page, 'utf8');
  s = s.includes('<!--live-->') ? s.replace(/<!--live-->[\s\S]*?<!--\/live-->/, block) : s.replace('</ul>', '</ul>' + block);
  fs.writeFileSync(page + '.tmp', s); fs.renameSync(page + '.tmp', page);
}
tick();
setInterval(tick, 60000);
