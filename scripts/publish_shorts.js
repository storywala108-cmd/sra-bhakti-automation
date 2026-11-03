// Shorts on days WITHOUT a new long video (asked 2026-11-01): take 2 unposted Shorts of the most recently
// published long video from Drive ("Ink & Crowns Published") and schedule them for the US morning and evening,
// each pointing to the full video. Usage: node scripts/publish_shorts.js [--force]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, env, log } from './lib.js';
import { folder, list, download, setProps, PUBLISHED } from './drive.js';
import { upload, api } from './yt.js';

const FORCE = process.argv.includes('--force');
const days = (env.PUBLISH_DAYS || '1,3,5').split(',').map(Number);
if (!FORCE && days.includes(new Date().getUTCDay())) { log('long-video day → no Shorts today'); process.exit(0); }
if (String(env.YT_ENABLED).toLowerCase() !== 'true') { log('YT_ENABLED is not true → no Shorts'); process.exit(0); }

const pid = await folder(PUBLISHED);
const files = await list(pid);
// newest published long video that still has unposted Shorts
const runs = [...new Set(files.filter(f => /^short\d\.mp4$/.test(f.appProperties?.kind || '') && !f.appProperties?.postedShort).map(f => f.appProperties.run))]
  .map(run => ({ run, at: files.find(f => f.appProperties?.run === run)?.appProperties?.publishedAt || '' }))
  .sort((a, b) => b.at.localeCompare(a.at));
if (!runs.length) { log('no unposted Shorts in Drive'); process.exit(0); }
// the full video must already be public, otherwise the Short's link would lead to a private video
let run, mine, videoId;
for (const r of runs) {
  const m = files.filter(f => f.appProperties?.run === r.run);
  const vid = m.find(f => f.appProperties?.videoId)?.appProperties.videoId;
  const st = vid ? (await api(`videos?part=status&id=${vid}`)).items?.[0]?.status : null;
  if (st?.privacyStatus === 'public') { run = r.run; mine = m; videoId = vid; break; }
  log('skipping', r.run, '— its long video is not public yet');
}
if (!run) { log('no Shorts whose full video is public yet'); process.exit(0); }
const tmp = path.join(ROOT, 'runs', '_shorts'); fs.mkdirSync(tmp, { recursive: true });
const metaF = mine.find(f => f.appProperties.kind === 'shorts.json');
await download(metaF.id, path.join(tmp, 'shorts.json'));
const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'shorts.json'), 'utf8'));
const todo = mine.filter(f => /^short\d\.mp4$/.test(f.appProperties.kind) && !f.appProperties.postedShort)
  .sort((a, b) => a.appProperties.kind.localeCompare(b.appProperties.kind)).slice(0, 2);

// 9 AM and 6 PM US Eastern (14:00 / 23:00 UTC); a slot less than 30 min away goes public right away
const slots = [14, 23].map(h => { const d = new Date(); d.setUTCHours(h, 0, 0, 0); return d; });
for (const [k, f] of todo.entries()) {
  const m = meta.find(x => x.file === f.appProperties.kind) || { title: 'A story worth the full watch' };
  const local = path.join(tmp, f.appProperties.kind);
  await download(f.id, local);
  const slot = slots[Math.min(k, 1)];
  const publishAt = slot - Date.now() > 30 * 60e3 ? slot.toISOString() : null;
  const description = `For the full video, click this link and watch the full story: https://youtu.be/${videoId}\n\n` +
    `More history every Monday, Wednesday and Friday on Ink & Crowns.\n#shorts #history`;
  const v = await upload(local, { title: `${m.title} #shorts`.slice(0, 100), description, tags: ['history', 'shorts', 'history facts'],
    publishAt, privacy: 'public', synthetic: String(env.YT_SYNTHETIC).toLowerCase() === 'true' });
  // marked right after the upload so a crash never posts the same Short twice
  await setProps(f.id, { postedShort: v.id, postedAt: new Date().toISOString() });
  log(`SHORT ${k + 1}: https://youtube.com/shorts/${v.id} ${publishAt ? '(public ' + publishAt + ')' : '(public now)'}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
