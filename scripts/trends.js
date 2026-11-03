// Trend research → one fresh topic. Reads what history videos get the most views per day right now (US),
// what worked on our own channel (state/learnings.json), and skips every topic we already made.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, aiJson, log } from './lib.js';
import { topRecent, channelSubs, topComments } from './yt.js';

// Owner's formats (2026-11-01): the channel only makes these kinds of history / geopolitics explainers.
// Each run focuses on the format used least recently, so the channel rotates through all of them.
export const FORMATS = [
  { id: 'versus', name: 'Country vs country: why one pulled ahead and the other fell behind (e.g. why Ukraine fell behind Russia)',
    queries: ['why country fell behind', 'country comparison history explained', 'why rich country poor country history'] },
  { id: 'rise', name: 'How a nation or empire became a superpower (e.g. how America became a superpower)',
    queries: ['how america became superpower', 'rise of empire explained', 'how country became rich history'] },
  { id: 'war', name: 'A war explained: why it started, who won, how and why — the strategy, technology and turning points',
    queries: ['war explained documentary', 'how they won the war strategy', 'military history battle explained'] },
  { id: 'mocked', name: 'A great person mocked by the world who succeeded anyway (inventions, discoveries, bold work)',
    queries: ['inventor everyone laughed at', 'genius ridiculed history', 'invention that changed the world story'] },
  { id: 'cause', name: 'The real causes of a war or conflict between two countries, explained (including ongoing ones)',
    queries: ['real reason for war explained', 'conflict explained geopolitics', 'why are they fighting explained'] },
  { id: 'risegroup', name: 'How a small group or movement grew into a major force (e.g. how the Houthis went from a small tribe to attacking a state)',
    queries: ['houthis explained', 'how group became powerful explained', 'rise of militia explained'] },
  { id: 'secretop', name: 'A secret military or intelligence operation, how it was planned and pulled off (e.g. the bin Laden raid)',
    queries: ['secret military operation explained', 'special forces raid documentary', 'intelligence operation history'] },
  { id: 'mystery', name: 'A big historical mystery or controversy examined with the evidence (e.g. the COVID-19 origins debate)',
    queries: ['history mystery explained evidence', 'origins debate explained', 'unsolved history mystery'] },
];
const STATE = path.join(ROOT, 'state');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch { return d; } };

// the format we used least recently (never-used first)
export function nextFormat() {
  const used = readJson('topics.json', []);
  const last = Object.fromEntries(FORMATS.map(f => [f.id, -1]));
  used.forEach((u, i) => { if (u.format in last) last[u.format] = i; });
  return FORMATS.slice().sort((a, b) => last[a.id] - last[b.id])[0];
}

export async function researchTrends(format = nextFormat()) {
  const seen = new Map();
  // the format's 3 queries + 1 general one ≈ 400 quota units per run
  for (const q of [...format.queries, 'history documentary']) {
    try { for (const v of await topRecent(q)) seen.set(v.id, v); } catch (e) { log('search failed', q, e.message.slice(0, 120)); }
  }
  // podcasts / interviews (> 75 min) and clips (< 8 min) are not our format
  // English titles only (Hindi/Spanish hits rank high but say nothing about US demand)
  const english = t => !/[^\u0000-ɏ -⁯\u{1F000}-\u{1FFFF}☀-➿]/u.test(t) && !/[¿¡ñ]|\b(qué|cómo|historia|guerra|documental)\b/i.test(t);
  const vids = [...seen.values()].filter(v => v.minutes >= 8 && v.minutes <= 75 && english(v.title));
  // outlier = views ÷ subscribers: a small channel's hit shows topic demand, a giant channel's shows only its fame
  const subs = await channelSubs([...new Set(vids.map(v => v.channelId))]).catch(e => { log('subs failed', e.message.slice(0, 120)); return {}; });
  for (const v of vids) {
    v.subs = subs[v.channelId] || 0;
    v.outlier = +(v.views / Math.max(1000, v.subs)).toFixed(2);
    v.score = Math.round(v.perDay * Math.sqrt(Math.min(50, Math.max(0.1, v.outlier))));
  }
  const list = vids.sort((a, b) => b.score - a.score).slice(0, 40);
  const requests = await viewerRequests(list);
  fs.writeFileSync(path.join(STATE, 'trends.json'), JSON.stringify({ at: new Date().toISOString(), list, requests }, null, 2));
  log('trending videos', list.length, 'top', list[0]?.perDay, '/day, outlier', list[0]?.outlier, '| viewer requests', requests.length);
  return Object.assign(list, { requests });
}

// "Do a video on X" comments under the top trend videos and our own uploads (1 quota unit per video)
const ASK = /\b(video|episode|part 2|next|cover|do one|you should|please (do|make)|would love|talk about)\b/i;
async function viewerRequests(list) {
  const ours = readJson('uploads.json', []).slice(-10).map(u => ({ id: u.id, title: u.title, own: true }));
  const out = [];
  for (const v of [...ours, ...list.slice(0, 8)]) {
    for (const c of await topComments(v.id)) {
      if (ASK.test(c.text) && c.text.length < 280) out.push({ on: v.title, own: !!v.own, likes: c.likes, text: c.text.replace(/\s+/g, ' ') });
    }
  }
  // our own viewers first, then the most liked
  return out.sort((a, b) => (b.own - a.own) || (b.likes - a.likes)).slice(0, 25);
}

// code-side guard: the reply must say which owner format it belongs to and be a real, dated event
const fits = t => FORMATS.some(f => f.id === t.format) && Number(t.year) > 0;

export async function pickTopic(trending, format = nextFormat(), audience = null) {
  const used = readJson('topics.json', []);
  const learn = readJson('learnings.json', {});
  const { data, model } = await aiJson(
    `You plan videos for "Ink & Crowns", an American history & geopolitics storytelling YouTube channel ` +
    `(15-21 min, US/UK audience).\nThis video's FORMAT: ${format.name} (format id "${format.id}").\n` +
    `Demand signal: these videos get the most views per day right now (title | views/day | outlier = views ÷ the ` +
    `channel's subscribers; above 1 means the TOPIC pulled viewers, not the channel's fame):\n` +
    trending.map(v => `- ${v.title} | ${v.perDay} | ${v.outlier ?? '?'}x`).join('\n') +
    (trending.requests?.length ? `\n\nWhat viewers are asking for in comments (likes; "OUR" = our own channel, weigh these most):\n` +
      trending.requests.map(r => `- ${r.own ? 'OUR ' : ''}(${r.likes}) ${r.text}`).join('\n') : '') +
    // competitor watch (competitors.js): what over-performs on rival channels and what their viewers ask for
    (audience?.wants?.length ? `\n\nCompetitor analysis (what this audience demands; strength 1-10):\n` +
      audience.wants.map(w => `- [${w.strength}] ${w.topic} — ${w.evidence}`).join('\n') +
      (audience.gaps?.length ? `\nGaps viewers say nobody covers well: ${audience.gaps.join('; ')}` : '') +
      (audience.saturated?.length ? `\nSaturated right now (avoid unless a truly new angle): ${audience.saturated.join('; ')}` : '') : '') +
    `\n\nWhat worked / didn't on OUR channel so far: ${JSON.stringify(learn.summary || 'no data yet')}\n` +
    `Topics we already made (never repeat): ${used.map(u => u.topic).join('; ') || 'none'}\n\n` +
    `Propose 5 ORIGINAL topics for THIS FORMAT with the highest US demand right now. Each must be a specific, real, ` +
    `well-documented story (we fact-check) with a fresh angle — not a copy of any title above. Recent events ` +
    `(e.g. the bin Laden raid, the Houthis, ongoing wars) are fine when explained historically and neutrally. ` +
    `Prefer human drama, a twist and a clear place on a map. Rules that keep the channel monetized: no graphic ` +
    `violence or gore, never glorify terrorists or armed groups, no partisan US domestic politics, no hate; ` +
    `contested claims (e.g. COVID-19 origins) are framed as an evidence-based debate presenting the main ` +
    `hypotheses and what official/intelligence assessments say — never "the hidden truth" or medical ` +
    `misinformation. Rank them by expected US views (demand signal + competitor analysis + our own results; ` +
    `a topic the competitor audience explicitly asks for and nobody covers well ranks highest).\n` +
    `Return JSON {"topics":[{"topic":"specific story, place, year","angle":"the hook in one line","why":"why it will get views",` +
    `"title":"YouTube title, max 60 chars, curiosity without clickbait lies","map_place":"main real place name",` +
    `"year":"main year as a number","format":"${format.id}"}]}`,
    // a reply without any usable topic for the format counts as bad, so aiJson asks again / tries the next model
    { check: d => { (d.topics || []).forEach(t => { t.format ||= format.id; }); if (!d.topics?.some(fits)) throw new Error('no topics for the format'); return d; }, temperature: 1.0 },
  );
  const usedSet = new Set(used.map(u => u.topic.toLowerCase()));
  const pick = data.topics.find(t => fits(t) && !usedSet.has(String(t.topic).toLowerCase()));
  if (!pick) throw new Error('no fresh topic for the format in the AI reply');
  log('topic by', model, '→', pick.topic);
  return { ...pick, candidates: data.topics };
}

if (process.argv[1]?.endsWith('trends.js')) {
  const f = nextFormat();
  const t = await researchTrends(f);
  const p = await pickTopic(t, f);
  console.log(JSON.stringify(p, null, 2));
}
