// Competitor watch (asked 2026-11-01): find the channels that keep winning in our niche, look at what their
// latest videos earn compared with their own normal, read the comments on their best ones, and let AI turn that
// into "what the audience wants next". The topic picker uses it so videos go where demand is highest.
// Quota per run ≈ 5 channels × (1 channel + 1 playlist + 1 stats + 3 comment pages) ≈ 30 units.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, aiJson, log } from './lib.js';
import { api, topComments } from './yt.js';

const STATE = path.join(ROOT, 'state');
const FILE = path.join(STATE, 'competitors.json');
const OWN_CHANNEL = 'UCOJV0D7GX1KlKQCJkIuqr7Q';
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// Every trend run votes for channels that ranked; the strongest mid-size channels become our competitors.
function updateRoster(trendList) {
  const db = rj(FILE, { channels: {} });
  for (const v of trendList) {
    if (!v.channelId || v.channelId === OWN_CHANNEL) continue;
    const c = db.channels[v.channelId] ||= { title: v.channel, hits: 0, outlierSum: 0, scannedAt: null };
    c.title = v.channel; c.subs = v.subs ?? c.subs; c.hits++; c.outlierSum += Math.min(50, v.outlier || 1); c.lastSeen = new Date().toISOString();
  }
  return db;
}

// 10k-5M subscribers: big enough to be a real channel, small enough that a hit means the topic, not fame
const ranked = db => Object.entries(db.channels)
  .filter(([, c]) => !c.subs || (c.subs >= 10000 && c.subs <= 5000000))
  .map(([id, c]) => ({ id, ...c, strength: c.hits * (c.outlierSum / c.hits) }))
  .sort((a, b) => b.strength - a.strength);

async function scanChannel(ch) {
  const info = await api(`channels?part=contentDetails,statistics&id=${ch.id}`);
  const uploads = info.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return null;
  const pl = await api(`playlistItems?part=contentDetails&maxResults=20&playlistId=${uploads}`);
  const ids = pl.items.map(i => i.contentDetails.videoId).join(',');
  const vids = (await api(`videos?part=snippet,statistics,contentDetails&id=${ids}`)).items.map(x => {
    const age = Math.max(1, (Date.now() - Date.parse(x.snippet.publishedAt)) / 864e5);
    return { id: x.id, title: x.snippet.title, views: Number(x.statistics.viewCount || 0), perDay: Number(x.statistics.viewCount || 0) / age,
      comments: Number(x.statistics.commentCount || 0), ageDays: Math.round(age) };
  }).filter(v => v.ageDays >= 3);                     // too new to judge
  const norm = median(vids.map(v => v.perDay)) || 1;
  vids.forEach(v => { v.vsNormal = +(v.perDay / norm).toFixed(2); });   // how this video did vs the channel's usual
  const best = vids.sort((a, b) => b.vsNormal - a.vsNormal).slice(0, 3);
  for (const v of best) v.topComments = (await topComments(v.id, 40)).sort((a, b) => b.likes - a.likes).slice(0, 15);
  return { channel: ch.title, subs: ch.subs, best, weakest: vids.slice(-2).map(v => ({ title: v.title, vsNormal: v.vsNormal })) };
}

export async function competitorDemand(trendList, { perRun = 5 } = {}) {
  const db = updateRoster(trendList);
  // rotate: the strongest competitors we haven't scanned for the longest
  const pick = ranked(db).slice(0, 15).sort((a, b) => String(a.scannedAt || '').localeCompare(String(b.scannedAt || ''))).slice(0, perRun);
  const scans = [];
  for (const ch of pick) {
    try { const s = await scanChannel(ch); if (s) scans.push(s); db.channels[ch.id].scannedAt = new Date().toISOString(); }
    catch (e) { log('competitor scan failed', ch.title, e.message.slice(0, 100)); }
  }
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
  if (!scans.length) { log('competitors: nothing scanned'); return rj(path.join(STATE, 'audience.json'), null); }

  const { data } = await aiJson(
    `You analyse competitor YouTube channels for "SRA भक्ति" (Hindi Hindu mythological kathas, Indian audience).\n` +
    `For each competitor: their videos that beat their own normal the most (vsNormal = views/day ÷ the channel's ` +
    `median; 3 = three times their usual), with top viewer comments, and their weakest recent videos:\n` +
    `${JSON.stringify(scans).slice(0, 14000)}\n\n` +
    `Work out what this audience demands: which subjects/angles over-perform, what viewers explicitly ask for ` +
    `("do X next", "part 2", questions left unanswered), what they complain is missing, and which subjects are ` +
    `saturated. Only Hindu mythology topics; never other religions.\nReturn JSON {"wants":[{"topic":"specific topic ` +
    `or angle","evidence":"which videos/comments show it","strength":1-10}],"gaps":["what viewers say nobody covers well"],` +
    `"saturated":["subjects done to death right now"],"title_patterns":["title styles that over-perform"]}`,
    { check: d => { if (!Array.isArray(d.wants)) throw new Error('no wants'); return d; }, temperature: 0.5 },
  );
  const out = { at: new Date().toISOString(), channels: scans.map(s => s.channel), ...data };
  fs.writeFileSync(path.join(STATE, 'audience.json'), JSON.stringify(out, null, 2));
  log(`competitors scanned: ${scans.map(s => s.channel).join(', ')} → ${data.wants.length} audience wants`);
  return out;
}

if (process.argv[1]?.endsWith('competitors.js')) {
  const t = rj(path.join(STATE, 'trends.json'), { list: [] });
  console.log(JSON.stringify(await competitorDemand(t.list), null, 2));
}
