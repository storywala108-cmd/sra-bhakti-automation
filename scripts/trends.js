// Trend research → one fresh topic. Reads what Hindi mythology videos get the most views per day right now (India),
// what worked on our own channel (state/learnings.json), and skips every topic we already made.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, aiJson, log } from './lib.js';
import { topRecent, channelSubs, topComments } from './yt.js';

// Owner's formats (2026-11-02): ONLY Hindu mythology, North Indian perspective, never another religion.
// Each run focuses on the format used least recently, so the channel rotates through all of them.
export const FORMATS = [
  { id: 'devi', name: 'A katha of Maa Durga / the Devi (Navratri stories, a devotee helped by the Mother, an asura defeated)',
    queries: ['माँ दुर्गा की कहानी', 'नवरात्रि कथा', 'devi maa story hindi'] },
  { id: 'shiv', name: 'A katha of Mahadev (Shiv Puran stories, his bhaktas, why he did something, Sawan kathas)',
    queries: ['भगवान शिव की कथा', 'शिव पुराण कथा', 'mahadev story hindi'] },
  { id: 'vishnu', name: 'A katha of Lord Vishnu and his avatars (Narasimha, Vaman, Ram, Krishna...)',
    queries: ['विष्णु अवतार कथा', 'श्री कृष्ण की कहानी', 'ram katha hindi'] },
  { id: 'devasura', name: 'A story of devas vs asuras/danavas (a great battle, a boon misused, how the asura was defeated)',
    queries: ['देव दानव युद्ध कथा', 'असुर की कहानी', 'rakshas story hindi'] },
  { id: 'kyun', name: 'A "क्यों / क्या / कैसे" katha: why a ritual, belief or festival exists, told through its scripture story',
    queries: ['क्यों करते हैं पूजा कथा', 'पौराणिक रहस्य', 'hindu dharm kyu kiya jata hai'] },
  { id: 'bhakt', name: 'The story of a great bhakta or rishi (Prahlad, Dhruv, Narad, Markandeya, Sabari...) and the lesson',
    queries: ['भक्त की कहानी', 'ऋषि कथा', 'bhakt prahlad story'] },
  { id: 'niti', name: 'Moral lessons from a Purana / Mahabharata / Ramayana episode (niti, karma, dharma) told as a story',
    queries: ['महाभारत की सीख', 'रामायण कथा सीख', 'karma ki kahani hindi'] },
];
const STATE = path.join(ROOT, 'state');
// reference channel (Niti Mantra) stories we must never copy (owner: copy only the format)
const AVOID = ['माँ दुर्गा और बूढ़ी औरत जिसने माता से काम करवाया', 'पापी राजा माँ दुर्गा से बचकर कहाँ भागेगा', '7 बातें परिवार को भी मत बताना (चाणक्य)'];
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
  for (const q of [...format.queries, 'पौराणिक कथा']) {
    try { for (const v of await topRecent(q)) seen.set(v.id, v); } catch (e) { log('search failed', q, e.message.slice(0, 120)); }
  }
  // podcasts (> 75 min) and clips (< 8 min) are not our format
  const vids = [...seen.values()].filter(v => v.minutes >= 8 && v.minutes <= 75);
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
const fits = t => FORMATS.some(f => f.id === t.format) && String(t.topic || '').length > 5;

export async function pickTopic(trending, format = nextFormat(), audience = null) {
  const used = readJson('topics.json', []);
  const learn = readJson('learnings.json', {});
  const { data, model } = await aiJson(
    `You plan videos for "SRA भक्ति", a Hindi YouTube channel of Hindu mythological kathas (about 13 min, Indian ` +
    `Hindi-belt audience, North Indian perspective).\nThis video's FORMAT: ${format.name} (format id "${format.id}").\n` +
    `Demand signal: these Hindi videos get the most views per day right now (title | views/day | outlier = views ÷ the ` +
    `channel's subscribers; above 1 means the TOPIC pulled viewers, not the channel's fame):\n` +
    trending.map(v => `- ${v.title} | ${v.perDay} | ${v.outlier ?? '?'}x`).join('\n') +
    (trending.requests?.length ? `\n\nWhat viewers are asking for in comments (likes; "OUR" = our own channel, weigh these most):\n` +
      trending.requests.map(r => `- ${r.own ? 'OUR ' : ''}(${r.likes}) ${r.text}`).join('\n') : '') +
    (audience?.wants?.length ? `\n\nCompetitor analysis (what this audience demands; strength 1-10):\n` +
      audience.wants.map(w => `- [${w.strength}] ${w.topic} — ${w.evidence}`).join('\n') +
      (audience.gaps?.length ? `\nGaps viewers say nobody covers well: ${audience.gaps.join('; ')}` : '') +
      (audience.saturated?.length ? `\nSaturated right now (avoid unless a truly new angle): ${audience.saturated.join('; ')}` : '') : '') +
    `\n\nWhat worked / didn't on OUR channel so far: ${JSON.stringify(learn.summary || 'no data yet')}\n` +
    `Never copy these reference-channel stories (we copy only the format): ${AVOID.join('; ')}\n` +
    `Topics we already made (never repeat): ${used.map(u => u.topic).join('; ') || 'none'}\n\n` +
    `Propose 5 ORIGINAL katha topics for THIS FORMAT with the highest demand right now. Only Hindu mythology from ` +
    `the scriptures (Puranas, Ramayana, Mahabharata) or well-known North Indian folk kathas; NEVER any other religion; ` +
    `always respectful; no gore. Each needs a strong hook (a question, a twist, a divine moment) and must not be a ` +
    `copy of any title above. Rank them by expected views.\n` +
    `Return JSON {"topics":[{"topic":"the katha in Hindi (Devanagari), specific","angle":"the hook in one Hindi line",` +
    `"why":"why it will get views","title":"YouTube title idea in Hindi","format":"${format.id}"}]}`,
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
