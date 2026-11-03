// Weekly self-analysis: reads our videos' analytics, finds what works (topics, length, retention),
// writes state/learnings.json (used by the topic picker and writers) and a human-readable report.
// Optional (TITLE_REFRESH=true): one new title for a video that clearly under-performs after 4+ days.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, env, aiJson, log } from './lib.js';
import { videoStats, updateTitle, api } from './yt.js';

const STATE = path.join(ROOT, 'state');
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch { return d; } };
const uploads = rj('uploads.json', []);
const today = new Date().toISOString().slice(0, 10);

const stats = await videoStats('2026-11-01', today).catch(e => { log('analytics failed:', e.message.slice(0, 160)); return []; });
const byId = Object.fromEntries(stats.map(s => [s.video, s]));
const rows = uploads.map(u => ({ ...u, ...(byId[u.id] || {}), ageDays: Math.max(0, (Date.now() - Date.parse(u.publishAt || u.at)) / 864e5) }))
  .filter(r => r.ageDays >= 2);
if (!rows.length) { log('not enough published videos yet for analysis'); process.exit(0); }

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const medViewsPerDay = median(rows.map(r => (r.views || 0) / Math.max(1, r.ageDays)));
const { data } = await aiJson(
  `You are the analyst for a new US history YouTube channel. Per-video data (views, averageViewPercentage = retention, ` +
  `averageViewDuration seconds, subscribersGained, ageDays, title, topic):\n${JSON.stringify(rows.map(r => ({
    title: r.title, topic: r.topic, views: r.views || 0, retention: r.averageViewPercentage, avgDur: r.averageViewDuration,
    subs: r.subscribersGained, ageDays: Math.round(r.ageDays) })))}\n` +
  `Find concrete patterns (which topics/eras/title styles get views and hold attention, where retention drops). ` +
  `Return JSON {"summary":"5-8 short rules the topic picker and script writer must follow next","report":"plain-English ` +
  `report for the owner, 6-10 lines","weak":[{"title":"existing title of a clearly weak video","new_title":"better honest title, max 60 chars"}]}`,
  { check: d => { if (!d.summary) throw new Error('no summary'); return d; }, temperature: 0.5 },
);
fs.writeFileSync(path.join(STATE, 'learnings.json'), JSON.stringify({ at: new Date().toISOString(), medViewsPerDay, summary: data.summary }, null, 2));
fs.writeFileSync(path.join(STATE, 'REPORT.md'), `# Ink & Crowns weekly report (${today})\n\n${data.report}\n\nRules for next videos:\n${data.summary}\n`);
log('learnings saved');

if (String(env.TITLE_REFRESH).toLowerCase() === 'true') {
  const done = rj('title_refresh.json', []);
  for (const w of data.weak || []) {
    const r = rows.find(x => x.title === w.title);
    if (!r || done.includes(r.id) || r.ageDays < 4 || (r.views || 0) / r.ageDays > medViewsPerDay * 0.5) continue;
    await updateTitle(r.id, w.new_title.slice(0, 100));
    done.push(r.id); log('title refreshed:', r.title, '→', w.new_title);
  }
  fs.writeFileSync(path.join(STATE, 'title_refresh.json'), JSON.stringify(done, null, 2));
}
