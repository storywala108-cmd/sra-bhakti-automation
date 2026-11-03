// Full Hindi katha script: outline → chapter by chapter (draft + human-editor pass) → banned-phrase sweep →
// web fact-check (Groq browser_search) → packaging (title, description, tags, thumbnail text).
import fs from 'node:fs';
import { aiJson, env, httpJson, log, parseJson } from './lib.js';
import { NARRATOR, BANNED, bannedHits } from './script_writer.js';

const words = s => String(s).trim().split(/\s+/).filter(Boolean).length;
// spoken Hindi from Gemini TTS is about 130 words/min -> 1,700 words is about 13 min (owner: long videos like the reference)
const TARGET = Number(env.TARGET_WORDS || 1700);
const SCENE_SHAPE = `"scenes":[{"text":"Hindi narration in Devanagari, 1-2 sentences, about 15-22 words (one picture
on screen per scene)","prompt":"in ENGLISH: one clear picture for this moment: always NAME each god/goddess/character
(Lord Shiva, Lord Vishnu, Goddess Lakshmi, Indra, the devtas, the asuras...), what they do, place, light and mood; one
main subject, close or medium shot so faces are big and clear; devtas never have beards; no blood or gore; no text"}]`;

function normScenes(d) {
  const scenes = (d.scenes || []).map(s => ({
    text: String(s.text || s.narration || '').trim(),
    visual: 'ink',
    prompt: String(s.prompt || s.image_prompt || '').trim(),
    place: s.place || null,
  })).filter(s => s.text);
  if (scenes.length < 3) throw new Error('too few scenes');
  return { ...d, scenes };
}

export async function outline(topic) {
  const { data } = await aiJson(
    `${NARRATOR}\n\nPlan a Hindi katha video of about ${Math.round(TARGET / 130)} minutes about: ${topic.topic}\nHook angle: ${topic.angle}\n` +
    `Structure like a gripping storyteller: a cold open at the most dramatic moment, then ${Math.max(3, Math.round(TARGET / 220))} ` +
    `chapters that build (the world and the characters, the trouble / the asura or the test, rising danger, the ` +
    `divine turn, the climax, the ending and what it teaches). Keep to what the scriptures / known kathas say.\n` +
    `Return JSON {"cold_open":"what happens in the first 20 seconds","chapters":[{"name":"short Hindi chapter title",` +
    `"beats":["beat 1","beat 2","..."],"key_facts":["names, places and events from the scripture"]}],"ending":"the final line idea"}`,
    { check: d => { if (!d.chapters?.length) throw new Error('no chapters'); return d; } },
  );
  return data;
}

async function writeChapter(topic, plan, i, prevTail) {
  const ch = i < 0 ? { name: 'Cold open', beats: [plan.cold_open], key_facts: [] } : plan.chapters[i];
  // 15-21 min: the TTS reads 145-175 wpm depending on the model (lite read 2,300 words in 13.1 min), so aim
  // ~3,000 words; drafts come out ~10% short (asked 2026-11-01)
  const target = i < 0 ? 70 : Math.round(TARGET / plan.chapters.length);
  const isLast = i === plan.chapters.length - 1;
  const what = i < 0
    ? 'the COLD OPEN (start at the most dramatic moment with a vivid detail; no question as the first line; ' +
      'end on a line that makes the listener stay for the whole katha)'
    : `chapter "${ch.name}"`;
  const ask = `${NARRATOR}\n\nVideo: ${topic.topic}. Full plan: ${JSON.stringify(plan)}\n` +
    `Write ${what} in Hindi — about ${target} words, ${Math.max(3, Math.round(target / 18))} scenes. ` +
    (prevTail ? `It continues right after: "${prevTail}". Flow on naturally, don't recap. ` : '') +
    (isLast ? `This is the final chapter: land the ending (${plan.ending}) with its lesson inside the story, then one ` +
      `short warm line asking viewers to write the jaikara (e.g. "जय माता दी") in the comments. ` : '') +
    `\nReturn JSON {${SCENE_SHAPE}}`;
  const draft = await aiJson(ask, { check: normScenes });
  const edited = await aiJson(
    `${NARRATOR}\n\nYou are the human script editor. Make this Hindi sound like a real kathavachak speaking: vary ` +
    `rhythm, cut filler and repeated words, keep the feeling and every scripture detail, keep scenes/prompts. ` +
    `No banned phrases.\nDRAFT: ${JSON.stringify(draft.data)}\nReturn JSON {${SCENE_SHAPE}}`,
    { check: normScenes, temperature: 0.8 },
  );
  return { name: ch.name, scenes: edited.data.scenes, model: edited.model };
}

// Groq gpt-oss with built-in web search checks the claims, ONE CHAPTER per call (the whole script at once hit
// Groq's tokens-per-minute limit, 2026-11-01), with a pause between chapters.
async function factCheck(chapters) {
  const fixes = [];
  let model = null;
  // web search results make each call ~8-10k tokens; Groq free allows about one such call per minute
  for (const [ci, c] of chapters.entries()) {
    let r = await factCheckText(c.scenes.map((s, si) => `[${ci}.${si}] ${s.text}`).join('\n'));
    if (!r.model) { await new Promise(x => setTimeout(x, 65000)); r = await factCheckText(c.scenes.map((s, si) => `[${ci}.${si}] ${s.text}`).join('\n')); }
    fixes.push(...r.fixes); model = r.model || model;
    await new Promise(x => setTimeout(x, 65000));
  }
  return { model, fixes };
}

async function factCheckText(text) {
  for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
    try {
      const d = await httpJson('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model, temperature: 0.2, tools: [{ type: 'browser_search' }],
          messages: [{ role: 'user', content:
            `Fact-check this Hindi narration of a Hindu mythological story with web search against the scriptures ` +
            `(Puranas, Ramayana, Mahabharata) and well-known kathas. For every line with a wrong name, relation, place, ` +
            `event or a wrongly cited scripture, give a corrected line in the same Hindi voice. Ignore the storytelling ` +
            `style; folk kathas are fine when they are not presented as scripture.\n` +
            `${text}\n\nAnswer ONLY JSON: {"fixes":[{"id":"chapter.scene","text":"corrected narration","why":"short reason"}]}` }],
        }),
      }, { tries: 2, timeoutMs: 180000 });
      const j = parseJson(d.choices?.[0]?.message?.content || '');
      return { model, fixes: Array.isArray(j.fixes) ? j.fixes : [] };
    } catch (e) { log('fact-check', model, 'failed:', e.message.slice(0, 120)); }
  }
  return { model: null, fixes: [] };
}

// cacheFile: outline + finished chapters are saved as they're made, so a restart continues instead of starting over
export async function writeLongScript(topic, cacheFile) {
  const cache = (() => { try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return {}; } })();
  const keep = () => cacheFile && fs.writeFileSync(cacheFile, JSON.stringify(cache));
  log('outline…');
  const plan = cache.plan || (cache.plan = await outline(topic));
  keep();
  const chapters = cache.chapters || (cache.chapters = []);
  let tail = chapters.at(-1)?.scenes.at(-1).text || '';
  for (let i = chapters.length - 1; i < plan.chapters.length; i++) {
    const c = await writeChapter(topic, plan, i, tail);
    chapters.push(c); keep();
    tail = c.scenes.at(-1).text;
    log(`chapter ${i + 1}/${plan.chapters.length}: ${c.name} (${words(c.scenes.map(s => s.text).join(' '))} words, ${c.model})`);
  }
  // too short? add real scenes to the thinnest chapters
  for (let pass = 0; pass < 5; pass++) {
    const total = words(chapters.flatMap(c => c.scenes.map(s => s.text)).join(' '));
    if (total >= TARGET * 0.9) break;
    const ci = chapters.map((c, k) => [k, words(c.scenes.map(s => s.text).join(' '))]).filter(([k]) => k > 0)
      .sort((a, b) => a[1] - b[1])[0][0];
    const c = chapters[ci];
    log(`script ${total} words < ${Math.round(TARGET * 0.9)} → adding scenes to "${c.name}"`);
    // asking to "expand" returned the same length; asking for NEW scenes to insert actually adds words
    const need = Math.min(6, Math.max(3, Math.round((TARGET - total) / 18 / 2)));
    const r = await aiJson(`${NARRATOR}\n\nVideo about ${topic.topic}. This chapter is too thin:\n${JSON.stringify(c.scenes.map(s => s.text))}\n` +
      `Write ${need} NEW Hindi scenes (15-22 words each) with more detail from the katha — what the characters ` +
      `said and felt, the place, the divine moment — that fit between or after these lines. Don't repeat anything. ` +
      `Return JSON {"after_scene": index of the existing scene they follow (0-based), ${SCENE_SHAPE}}`,
      { check: normScenes, temperature: 0.8 }).catch(() => null);
    if (!r) break;
    const at = Math.min(c.scenes.length - 1, Math.max(0, Number(r.data.after_scene ?? c.scenes.length - 1)));
    c.scenes.splice(at + 1, 0, ...r.data.scenes);
  }

  // banned phrases: rewrite only the offending scenes
  for (const c of chapters) {
    for (const s of c.scenes) {
      const hits = bannedHits(s.text);
      if (!hits.length) continue;
      const r = await aiJson(`Rewrite this narration line without the phrases ${hits.join(', ')}, same voice and facts. ` +
        `Line: "${s.text}"\nReturn JSON {"text":"..."}`, { check: d => { if (!d.text) throw new Error('empty'); return d; } });
      s.text = r.data.text;
    }
  }
  log('style sweeps (length, tics, banned phrases)…');
  // repeated tics across chapters ("Honestly?" in every chapter sounded robotic in the first test)
  const tics = ['दोस्तों', 'सच में', 'सोचिए'];
  for (const tic of tics) {
    const hits = chapters.flatMap(c => c.scenes).filter(s => s.text.includes(tic));
    for (const s of hits.slice(1)) {
      const r = await aiJson(`${NARRATOR}\nRewrite this line without "${tic.trim()}", same meaning and voice: "${s.text}"\nReturn JSON {"text":"..."}`,
        { check: d => { if (!d.text) throw new Error('empty'); return d; } });
      s.text = r.data.text;
    }
  }

  // fact-check, then put each correction back into the narrator's own voice (raw fixes read like footnotes)
  log('fact-check…');
  const fc = await factCheck(chapters);
  const clean = t => String(t).replace(/【[^】]*】/g, '').replace(/ | /g, ' ').replace(/\s{2,}/g, ' ').trim();
  for (const f of fc.fixes) {
    const [ci, si] = String(f.id).split('.').map(Number);
    const sc = chapters[ci]?.scenes[si];
    if (!sc || !f.text) continue;
    try {
      const r = await aiJson(`${NARRATOR}\nThis narration line has a factual error.\nLine: "${sc.text}"\n` +
        `Correct fact: ${clean(f.why)} ${clean(f.text)}\nRewrite the line as natural spoken narration with the correct ` +
        `fact (or drop the doubtful claim). No sources, no brackets, no "not X" corrections. Return JSON {"text":"..."}`,
        { check: d => { if (!d.text) throw new Error('empty'); return d; }, temperature: 0.6 });
      sc.text = clean(r.data.text); sc.factFixed = clean(f.why);
    } catch { /* keep the original line rather than a footnote-style fix */ }
  }
  log('fact-check by', fc.model, 'fixes', fc.fixes.length);

  const all = chapters.flatMap(c => c.scenes.map(s => s.text)).join(' ');
  const { data: pack } = await aiJson(
    `${NARRATOR}\n\nPackage this Hindi katha video for YouTube India. Script: ${all.slice(0, 6000)}\n` +
    `Return JSON {"title":"max 80 chars: Hindi words in Devanagari plus 1-2 English keywords (e.g. Maa Durga Story), ` +
    `an honest curiosity hook, one emoji","thumb_text":"2-4 big Hindi words for the thumbnail (Devanagari), a hook ` +
    `different from the title, e.g. और फिर… चमत्कार हुआ!","thumb_prompt":"in ENGLISH: the thumbnail picture: NAME the ` +
    `god/goddess, ONE big main subject on the RIGHT half (face and chest large, strong emotion, glowing), bright vivid ` +
    `colours, dramatic sky, the LEFT 40% simple and dark enough for big text, no text","description":"2 short ` +
    `paragraphs in ENGLISH about the story and its lesson, then one line inviting viewers to write the jaikara in the ` +
    `comments","tags":["12-15 tags, Hindi and English"]}`,
    { check: d => { if (!d.title || !d.description) throw new Error('no package'); return d; } },
  );
  await verifyPack(pack, all);
  return { topic, plan, chapters, pack, words: words(all), banned_left: bannedHits(all), fact_fixes: fc.fixes };
}

// The first dry run produced "Americans Sold Trucks to Save Nazi Horses" — nothing was sold. Misleading titles
// hurt trust and the channel, so title + thumbnail text must be literally supported by the script.
export async function verifyPack(pack, script) {
  const { data } = await aiJson(
    `Script of a Hindi mythological katha video:\n${script.slice(0, 9000)}\n\nProposed YouTube title: "${pack.title}"\nThumbnail text: "${pack.thumb_text}"\n` +
    `Check that the title and thumbnail text only promise what really happens in this script. Curiosity is fine, ` +
    `invented events are not. Return JSON {"title_ok":true/false,"thumb_ok":true/false,` +
    `"title":"the same title if ok, else an honest curiosity title (Hindi Devanagari + 1-2 English keywords) max 80 chars","thumb_text":"same if ok, else 2-4 honest Hindi words","why":"short"}`,
    { check: d => { if (!d.title) throw new Error('no verdict'); return d; }, temperature: 0.3 },
  );
  if (!data.title_ok) { log('title fixed:', pack.title, '→', data.title, `(${data.why})`); pack.title = data.title; }
  if (!data.thumb_ok && data.thumb_text) { log('thumb text fixed:', pack.thumb_text, '→', data.thumb_text); pack.thumb_text = data.thumb_text; }
  return pack;
}
