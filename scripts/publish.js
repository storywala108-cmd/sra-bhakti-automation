// Publish day: take the OLDEST ready video from the Drive queue → YouTube (goes public at 6 PM Eastern) →
// move its files to "Published". Every run also deletes Published files 1 day after a confirmed upload.
// Usage: node scripts/publish.js [--force]   (--force = publish even if today isn't a publish day)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, env, log } from './lib.js';
import { folder, list, download, move, remove, usage, QUEUE, PUBLISHED } from './drive.js';
import { upload, setThumbnail, api } from './yt.js';

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
const days = (env.PUBLISH_DAYS || '1,3,5').split(',').map(Number);
const hour = Number(env.PUBLISH_HOUR_UTC || 22);
if (!FORCE && !days.includes(new Date().getUTCDay())) { log('not a publish day'); process.exit(0); }
if (String(env.YT_ENABLED).toLowerCase() !== 'true') { log('YT_ENABLED is not true → not publishing'); process.exit(0); }

const queue = await list(qid);
const runs = [...new Set(queue.filter(f => f.appProperties?.kind === 'final.mp4').map(f => f.appProperties.run))].sort();
log(`queue: ${runs.length} ready`, JSON.stringify(await usage()));
if (!runs.length) { log('WARNING: queue empty — nothing to publish today'); process.exit(0); }
const run = runs[0];
const files = Object.fromEntries(queue.filter(f => f.appProperties?.run === run).map(f => [f.appProperties.kind, f]));
const uploads = rj(uploadsFile, []);
const already = uploads.find(u => u.run === run);

const tmp = path.join(ROOT, 'runs', '_publish');
fs.mkdirSync(tmp, { recursive: true });
let videoId = already?.id;
if (!already) {
  for (const k of ['final.mp4', 'thumb.jpg', 'meta.json']) if (files[k]) await download(files[k].id, path.join(tmp, k));
  const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'meta.json'), 'utf8'));
  // preflight on the downloaded copy
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(tmp, 'final.mp4')]).toString());
  if (Math.abs(d - meta.duration) > 3) throw new Error(`downloaded video length ${d} ≠ ${meta.duration}`);
  const slot = new Date(); slot.setUTCHours(hour, 0, 0, 0);
  const publishAt = slot - Date.now() > 60 * 60e3 ? slot.toISOString() : null;   // < 1 h left → public right away
  log('uploading', meta.title, publishAt ? `(goes public ${publishAt})` : '(public now)');
  const v = await upload(path.join(tmp, 'final.mp4'), { title: meta.title, description: meta.description, tags: meta.tags,
    publishAt, privacy: 'public', synthetic: String(env.YT_SYNTHETIC).toLowerCase() === 'true' });
  videoId = v.id;
  uploads.push({ run, id: v.id, title: meta.title, topic: meta.topic, publishAt: publishAt || new Date().toISOString(), at: new Date().toISOString() });
  wj(uploadsFile, uploads);                                    // recorded before anything else can fail → never twice
  try { await setThumbnail(v.id, path.join(tmp, 'thumb.jpg')); log('thumbnail set'); } catch (e) { log('thumbnail failed:', e.message.slice(0, 120)); }
  log('UPLOADED https://youtu.be/' + v.id);
}
const props = { publishedAt: new Date().toISOString(), videoId };
for (const f of Object.values(files)) await move(f.id, qid, pid, props);
fs.rmSync(tmp, { recursive: true, force: true });
log('moved to Published; Drive copy is deleted 1 day after YouTube confirms processing');
