// Publish: take the OLDEST APPROVED video from the Drive queue (owner approves by starring final.mp4 in Google Drive)
// → YouTube (public) → Facebook page (full video) → Instagram (cut reel) → move to "Published".
// Each platform is recorded in state/uploads.json the moment it succeeds, so nothing is ever posted twice.
// Every run also deletes Published files 1 day after a confirmed upload.
// Usage: node scripts/publish.js [--force]   (--force = publish even if today isn't a publish day)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, env, log } from './lib.js';
import { folder, list, download, move, remove, usage, QUEUE, PUBLISHED } from './drive.js';
import { upload, setThumbnail, api } from './yt.js';
import { publishFacebookVideo, publishInstagramReel } from './social.js';

const FORCE = process.argv.includes('--force');
const STATE = path.join(ROOT, 'state');
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const wj = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(f + '.tmp', f); };
const uploadsFile = path.join(STATE, 'uploads.json');
const qid = await folder(QUEUE), pid = await folder(PUBLISHED);

// 1) cleanup: Published files older than 1 day whose YouTube video is processed → permanent delete (asked 2026-11-01)
const pub = await list(pid);
const byRun = {};
for (const f of pub) (byRun[f.appProperties?.run] ||= []).push(f);
for (const [run, files] of Object.entries(byRun)) {
  const at = Date.parse(files[0].appProperties?.publishedAt || files[0].modifiedTime);
  const vid = files[0].appProperties?.videoId;
  if (Date.now() - at < 24 * 3600e3) continue;
  let ok = false;
  try { const v = await api(`videos?part=status&id=${vid}`); ok = v.items?.[0]?.status?.uploadStatus === 'processed'; } catch { /* keep files */ }
  if (!ok) { log('cleanup: keeping', run, '(YouTube video not confirmed processed)'); continue; }
  // the long video's files go after 1 day; its Shorts stay until posted (+1 day), at most 10 days
  let gone = 0;
  for (const f of files) {
    const kind = f.appProperties?.kind || '';
    const isShort = /^short\d\.mp4$/.test(kind) || kind === 'shorts.json';
    const posted = f.appProperties?.postedAt ? Date.parse(f.appProperties.postedAt) : 0;
    const allShortsPosted = files.filter(x => /^short\d\.mp4$/.test(x.appProperties?.kind || '')).every(x => x.appProperties?.postedShort);
    const keep = isShort && Date.now() - at < 10 * 864e5 &&
      (kind === 'shorts.json' ? !allShortsPosted : (!posted || Date.now() - posted < 864e5));
    if (!keep) { await remove(f.id); gone++; }
  }
  if (gone) log('cleanup: deleted', gone, 'file(s) of', run);
}

// 2) publish
const days = (env.PUBLISH_DAYS || '0,1,2,3,4,5,6').split(',').map(Number);
const hour = Number(env.PUBLISH_HOUR_UTC || 14);   // 14:00 UTC = 7:30 PM IST
if (!FORCE && !days.includes(new Date().getUTCDay())) { log('not a publish day'); process.exit(0); }
if (String(env.YT_ENABLED).toLowerCase() !== 'true') { log('YT_ENABLED is not true → not publishing'); process.exit(0); }

const queue = await list(qid);
const ready = queue.filter(f => f.appProperties?.kind === 'final.mp4');
// approval gate (owner 2026-11-02): only videos whose final.mp4 is ⭐ starred in Google Drive go out
const runs = [...new Set(ready.filter(f => f.starred || String(env.REQUIRE_APPROVAL).toLowerCase() === 'false').map(f => f.appProperties.run))].sort();
log(`queue: ${ready.length} ready, ${runs.length} approved`, JSON.stringify(await usage()));
if (!runs.length) { log(ready.length ? 'waiting for approval: star the video in Drive folder "SRA Bhakti Queue"' : 'WARNING: queue empty'); process.exit(0); }
const run = runs[0];
const files = Object.fromEntries(queue.filter(f => f.appProperties?.run === run).map(f => [f.appProperties.kind, f]));
const uploads = rj(uploadsFile, []);
const already = uploads.find(u => u.run === run);

const tmp = path.join(ROOT, 'runs', '_publish');
fs.mkdirSync(tmp, { recursive: true });
let videoId = already?.id;
if (!already) {
  for (const k of ['final.mp4', 'thumb.jpg', 'meta.json', 'reel.mp4']) if (files[k]) await download(files[k].id, path.join(tmp, k));
  const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'meta.json'), 'utf8'));
  // preflight on the downloaded copy
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(tmp, 'final.mp4')]).toString());
  if (Math.abs(d - meta.duration) > 3) throw new Error(`downloaded video length ${d} ≠ ${meta.duration}`);
  const slot = new Date(); slot.setUTCHours(hour, 0, 0, 0);
  const publishAt = slot - Date.now() > 60 * 60e3 ? slot.toISOString() : null;   // < 1 h left → public right away
  log('uploading', meta.title, publishAt ? `(goes public ${publishAt})` : '(public now)');
  const v = await upload(path.join(tmp, 'final.mp4'), { title: meta.title, description: meta.description, tags: meta.tags,
    publishAt, privacy: 'public', categoryId: '24', synthetic: String(env.YT_SYNTHETIC ?? 'true').toLowerCase() === 'true' });
  videoId = v.id;
  uploads.push({ run, id: v.id, title: meta.title, topic: meta.topic, publishAt: publishAt || new Date().toISOString(), at: new Date().toISOString() });
  if (publishAt) log('note: YouTube goes public at', publishAt);
  wj(uploadsFile, uploads);                                    // recorded before anything else can fail → never twice
  try { await setThumbnail(v.id, path.join(tmp, 'thumb.jpg')); log('thumbnail set'); } catch (e) { log('thumbnail failed:', e.message.slice(0, 120)); }
  log('UPLOADED https://youtu.be/' + v.id);
}
// Facebook (full video) + Instagram (reel): each once, failures isolated from each other and from YouTube
const rec = rj(uploadsFile, []).find(u => u.run === run);
if (rec && !rec.fb && String(env.FB_ENABLED).toLowerCase() === 'true') {
  try {
    for (const k of ['final.mp4', 'thumb.jpg', 'meta.json']) if (files[k] && !fs.existsSync(path.join(tmp, k))) await download(files[k].id, path.join(tmp, k));
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'meta.json'), 'utf8'));
    rec.fb = await publishFacebookVideo(path.join(tmp, 'final.mp4'), path.join(tmp, 'thumb.jpg'), meta.title, meta.description);
    log('FACEBOOK', rec.fb);
  } catch (e) { log('facebook failed:', e.message.slice(0, 200)); if (e.maybePosted) rec.fb = 'maybe-posted'; }
  const all = rj(uploadsFile, []); Object.assign(all.find(u => u.run === run), rec); wj(uploadsFile, all);
}
if (rec && !rec.ig && files['reel.mp4'] && String(env.IG_ENABLED).toLowerCase() === 'true') {
  try {
    for (const k of ['reel.mp4', 'meta.json']) if (!fs.existsSync(path.join(tmp, k))) await download(files[k].id, path.join(tmp, k));
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'meta.json'), 'utf8'));
    rec.ig = await publishInstagramReel(path.join(tmp, 'reel.mp4'), meta.igCaption || meta.title);
    log('INSTAGRAM', rec.ig);
  } catch (e) { log('instagram failed:', e.message.slice(0, 200)); if (e.maybePosted) rec.ig = 'maybe-posted'; }
  const all = rj(uploadsFile, []); Object.assign(all.find(u => u.run === run), rec); wj(uploadsFile, all);
}
const props = { publishedAt: new Date().toISOString(), videoId };
for (const f of Object.values(files)) await move(f.id, qid, pid, props);
fs.rmSync(tmp, { recursive: true, force: true });
log('moved to Published; Drive copy is deleted 1 day after YouTube confirms processing');
