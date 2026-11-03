// SRA Bhakti pipeline. One call advances the current video as far as it can and saves progress:
// topic → Hindi katha script → voice → images (quota-aware, resumes next run) → thumbnail → render → preflight → queue.
// Usage: node scripts/pipeline.js [run|status] [--topic "..."] [--dry]   (dry = everything except the upload)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, env, log, tts, TTS_MODELS, fluxImage } from './lib.js';
import { makeThumb } from './thumb.js';
import { makeReel } from './reel.js';
import { researchTrends, pickTopic, nextFormat } from './trends.js';
import { competitorDemand } from './competitors.js';
import { makeShorts } from './shorts.js';
import { writeLongScript } from './long_script.js';
import { renderVideo, preflight, dur } from './render.js';
import { folder, list, uploadFile, QUEUE } from './drive.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const forcedTopic = args.includes('--topic') ? args[args.indexOf('--topic') + 1] : null;
const STATE = path.join(ROOT, 'state');
const RUNS = path.join(ROOT, 'runs');
fs.mkdirSync(STATE, { recursive: true }); fs.mkdirSync(RUNS, { recursive: true });
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wj = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(f + '.tmp', f); };
const flag = (k, d = 'false') => String(env[k] ?? d).toLowerCase() === 'true';
const IMAGES_PER_RUN = Number(env.IMAGES_PER_RUN || 60);
const VOICE = env.VOICE || 'Charon';

function currentRun() {
  const dirs = fs.readdirSync(RUNS).filter(d => fs.existsSync(path.join(RUNS, d, 'state.json'))).sort();
  for (const d of dirs) { const s = rj(path.join(RUNS, d, 'state.json')); if (s.stage !== 'done') return { dir: path.join(RUNS, d), s }; }
  return null;
}
const save = r => wj(path.join(r.dir, 'state.json'), r.s);

const BUFFER = Number(env.BUFFER_TARGET || 4);   // ready videos to keep waiting in Drive

async function step(r) {
  const { dir, s } = r;
  const scenes = () => s.script.chapters.flatMap((c, ci) => c.scenes.map((sc, si) => ({ ...sc, ci, si, chapterTitle: si === 0 && ci > 0 ? c.name : null })));

  if (s.stage === 'script') {
    log('writing script:', s.topic.topic);
    s.script = await writeLongScript(s.topic, path.join(dir, 'script_parts.json'));
    wj(path.join(dir, 'script.json'), s.script);
    s.stage = 'voice'; save(r);
  }
  if (s.stage === 'voice') {
    const sc = scenes();
    // chunks of whole scenes, ≤600 words, may span chapters (10 TTS requests/day on the free tier → ~5 per video)
    if (!s.chunks) {
      s.chunks = [];
      let cur = null;
      sc.forEach((x, i) => {
        const w = x.text.split(/\s+/).length;
        if (!cur || cur.words + w > 600) { cur = { ci: x.ci, scenes: [], words: 0 }; s.chunks.push(cur); }
        cur.scenes.push(i); cur.words += w;
      });
      save(r);
    }
    for (const [k, ch] of s.chunks.entries()) {
      const wavF = path.join(dir, `chunk${String(k).padStart(2, '0')}.wav`);
      if (fs.existsSync(wavF)) continue;
      try {
        // one model for the whole video: the first chunk picks it, the rest must use the same one
        const res = await tts(ch.scenes.map(i => sc[i].text).join('\n\n'), wavF, { voice: VOICE, models: s.ttsModel ? [s.ttsModel] : TTS_MODELS });
        if (!s.ttsModel) { s.ttsModel = res.model; }
        log(`voice chunk ${k + 1}/${s.chunks.length}: ${res.seconds.toFixed(0)} s (${res.model})`); save(r);
      } catch (e) {
        if (e.quota) { log(`TTS daily free quota used (${s.ttsModel || 'all models'}) → voice continues next run`); save(r); return 'waiting'; }
        throw e;
      }
    }
    // cut every chunk into scene clips at the silences between scenes (Whisper word timings)
    for (const [k, ch] of s.chunks.entries()) {
      const first = path.join(dir, `vo${String(ch.scenes[0]).padStart(3, '0')}.wav`);
      if (fs.existsSync(first)) continue;
      const list = path.join(dir, `chunk${k}.json`), tmpPrefix = path.join(dir, `cut${k}_`);
      fs.writeFileSync(list, JSON.stringify(ch.scenes.map(i => sc[i].text)));
      const out = execFileSync('python', ['-I', path.join(ROOT, 'scripts', 'align.py'), path.join(dir, `chunk${String(k).padStart(2, '0')}.wav`), list, tmpPrefix]).toString();
      log(`aligned chunk ${k + 1}: ${out.trim().slice(0, 120)}`);
      ch.scenes.forEach((i, j) => fs.renameSync(`${tmpPrefix}${String(j).padStart(3, '0')}.wav`, path.join(dir, `vo${String(i).padStart(3, '0')}.wav`)));
    }
    s.voiceSeconds = sc.reduce((a, _, i) => a + dur(path.join(dir, `vo${String(i).padStart(3, '0')}.wav`)), 0);
    log('voice', (s.voiceSeconds / 60).toFixed(1), 'min');
    s.stage = 'images'; save(r);
  }
  if (s.stage === 'images') {
    const sc = scenes();
    let made = 0, quotaHit = false;
    const todo = sc.map((x, i) => [x, i]).filter(([x, i]) => x.visual !== 'map' && !fs.existsSync(path.join(dir, `img${String(i).padStart(3, '0')}.jpg`)));
    const thumbBg = path.join(dir, 'thumb_bg.jpg');
    if (!fs.existsSync(thumbBg)) todo.unshift([{ prompt: s.script.pack.thumb_prompt }, 'thumb']);
    for (let k = 0; k < todo.length && made < IMAGES_PER_RUN && !quotaHit; k += 3) {
      await Promise.all(todo.slice(k, k + 3).map(async ([x, i]) => {
        const f = i === 'thumb' ? thumbBg : path.join(dir, `img${String(i).padStart(3, '0')}.jpg`);
        try { await fluxImage(x.prompt, f); made++; } catch (e) {
          if (/4006|daily|allocation|quota|429/i.test(e.message)) quotaHit = true;
          log('image', i, 'failed:', e.message.slice(0, 140));
        }
      }));
    }
    const left = sc.filter((x, i) => x.visual !== 'map' && !fs.existsSync(path.join(dir, `img${String(i).padStart(3, '0')}.jpg`))).length;
    log(`images made ${made}, left ${left}${quotaHit ? ' (free quota used up, continues next run)' : ''}`);
    if (left || !fs.existsSync(thumbBg)) { save(r); return 'waiting'; }
    s.stage = 'thumb'; save(r);
  }
  if (s.stage === 'thumb') {
    makeThumb(path.join(dir, 'thumb_bg.jpg'), path.join(dir, 'thumb.jpg'), s.script.pack.thumb_text, Math.random() < 0.5 ? 'left' : 'right');
    s.stage = 'render'; save(r);
  }
  if (s.stage === 'render') {
    const sc = scenes().map((x, i) => {
      const n = String(i).padStart(3, '0');
      const mapDir = path.join(dir, `map${n}`);
      const hasMap = fs.existsSync(path.join(mapDir, 'f0149.png'));
      return { ...x, visual: hasMap ? 'map' : 'ink', mapDir: hasMap ? mapDir : null, img: path.join(dir, `img${n}.jpg`),
        voFile: path.join(dir, `vo${n}.wav`), vo: dur(path.join(dir, `vo${n}.wav`)) };
    });
    // Mixkit tracks are fetched at run time (their licence doesn't allow re-hosting them in a public repo)
    const mdir = path.join(ROOT, 'music');
    fs.mkdirSync(mdir, { recursive: true });
    for (const m of rj(path.join(ROOT, 'data', 'music.json'), [])) {
      const f = path.join(mdir, `${m.name}.mp3`);
      if (fs.existsSync(f)) continue;
      const res = await fetch(m.url, { headers: { 'user-agent': 'SRABhakti/1.0' } });
      if (res.ok) fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      await new Promise(x => setTimeout(x, 1500));
    }
    const music = fs.readdirSync(mdir).filter(f => f.endsWith('.mp3')).map(f => path.join(mdir, f))
      .sort(() => Math.random() - 0.5);
    log('render', sc.length, 'scenes…');
    const out = renderVideo(sc, dir, { musicFiles: music.slice(0, 3) });
    const pf = preflight(out.final, out.total);
    log('preflight', JSON.stringify(pf));
    if (!pf.ok) throw new Error('preflight failed: ' + pf.problems.join(', '));
    // YouTube chapters from the real scene start times
    const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const marks = [['0:00', 'Intro']];
    sc.forEach((x, i) => { if (x.chapterTitle) marks.push([fmt(out.starts[i]), x.chapterTitle]); });
    s.chapters = marks; s.duration = out.total; s.music = music.slice(0, 3).map(f => path.basename(f, '.mp3'));
    s.sceneTimes = sc.map((x, i) => ({ text: x.text, start: out.starts[i], vo: x.vo }));
    s.stage = 'shorts'; save(r);
  }
  // 4 Shorts cut from this video, posted on the days without a new long video (asked 2026-11-01)
  if (s.stage === 'shorts') {
    // Instagram gets a cut reel of the video (owner 2026-11-03); a failure never blocks the long video
    try { s.reel = makeReel(dir, s.sceneTimes, s.script.pack.thumb_text); } catch (e) { log('reel failed:', e.message.slice(0, 160)); s.reel = null; }
    // YouTube Shorts need a Hindi layout first; default OFF until built and approved
    if (!flag('SHORTS_ENABLED')) { s.shorts = []; s.stage = 'upload'; save(r); }
    else try { s.shorts = await makeShorts(dir, s.script, s.sceneTimes); }
    catch (e) { log('shorts failed (long video still goes ahead):', e.message.slice(0, 160)); s.shorts = []; }
    s.stage = 'upload'; save(r);
  }
  // finished videos wait in Google Drive; publish.js takes the oldest on publish days (no last-minute rush)
  if (s.stage === 'upload' || s.stage === 'queue') {
    if (DRY) { log('dry run → not queued. Final:', path.join(dir, 'final.mp4')); return 'ready'; }
    const p = s.script.pack;
    const meta = {
      run: s.id, topic: s.topic.topic, title: p.title.slice(0, 100), tags: p.tags, duration: s.duration,
      // Instagram caption: hook + where the full katha is + hashtags (Hindi hook, English tags)
      igCaption: `${p.thumb_text} 🙏\nपूरी कथा YouTube (SRA@Bhakti Channel) और Facebook (SRA Bhakti Channel) पर।\n\n` +
        (p.tags || []).filter(t => /^[a-z0-9 ]+$/i.test(t)).slice(0, 8).map(t => '#' + t.replace(/\s+/g, '')).join(' ') + ' #bhakti #hindumythology #katha',
      description: `${p.description}\n\nChapters\n${s.chapters.map(([t, n]) => `${t} ${n}`).join('\n')}\n\n` +
        `Music: ${s.music.join(', ')} (Mixkit).\n\nDisclaimer: This video presents a devotional katha for faith, moral ` +
        `learning and entertainment. Visuals and voice are AI-generated.`,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    const qid = await folder(QUEUE);
    const have = (await list(qid)).filter(f => f.appProperties?.run === s.id).map(f => f.name);
    const files = [['final.mp4', 'video/mp4'], ['thumb.jpg', 'image/jpeg'], ['meta.json', 'application/json']];
    for (const sh of s.shorts || []) if (fs.existsSync(path.join(dir, sh.file))) files.push([sh.file, 'video/mp4']);
    if (s.shorts?.length) files.push(['shorts.json', 'application/json']);
    if (s.reel && fs.existsSync(path.join(dir, 'reel.mp4'))) files.push(['reel.mp4', 'video/mp4']);
    for (const [f, mime] of files) {
      if (have.includes(`${s.id}__${f}`)) continue;
      log('to Drive:', f);
      await uploadFile(path.join(dir, f), `${s.id}__${f}`, qid, mime, { run: s.id, kind: f });
    }
    s.stage = 'done'; s.queuedAt = new Date().toISOString(); save(r);
    // free the Actions cache: only state.json + script.json stay
    for (const f of fs.readdirSync(dir)) if (!['state.json', 'script.json'].includes(f)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    log('QUEUED in Google Drive (waiting for your ⭐ approval):', meta.title);
    return 'queued';
  }
  return s.stage;
}

async function main() {
  if (args[0] === 'status') { const c = currentRun(); console.log(c ? `${path.basename(c.dir)}: ${c.s.stage}` : 'no open run'); return; }
  let r = currentRun();
  if (!r && !DRY && env.DRIVE_REFRESH_TOKEN) {
    const ready = new Set((await list(await folder(QUEUE))).filter(f => f.appProperties?.kind === 'final.mp4').map(f => f.appProperties.run)).size;
    if (ready >= BUFFER) { log(`buffer full: ${ready} videos ready in Drive (target ${BUFFER}) → nothing to make`); return; }
    log(`buffer ${ready}/${BUFFER} → making the next video`);
  }
  if (!r) {
    const fmt = nextFormat();
    let topic;
    if (forcedTopic) topic = { topic: forcedTopic, angle: args.includes('--angle') ? args[args.indexOf('--angle') + 1] : '', title: forcedTopic, format: 'manual' };
    else {
      const trend = await researchTrends(fmt);
      const audience = await competitorDemand(trend).catch(e => { log('competitor analysis skipped:', e.message.slice(0, 120)); return null; });
      topic = await pickTopic(trend, fmt, audience);
    }
    log('format:', topic.format);
    // Hindi topics have no Latin letters → id from the date/time (+ the format)
    const id = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '-' + String(topic.format || 'katha').replace(/[^a-z0-9]+/gi, '');
    r = { dir: path.join(RUNS, id), s: { id, topic, stage: 'script', created: new Date().toISOString() } };
    fs.mkdirSync(r.dir, { recursive: true }); save(r);
    const used = rj(path.join(STATE, 'topics.json'), []); used.push({ topic: topic.topic, format: topic.format, run: id, at: r.s.created });
    wj(path.join(STATE, 'topics.json'), used);
    log('new video:', topic.topic);
  }
  const res = await step(r);
  log('result:', res);
}
main().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
