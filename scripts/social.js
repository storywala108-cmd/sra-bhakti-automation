// Facebook page: the FULL video (page video upload). Instagram: the cut reel (resumable upload).
// Both never retry after the publish call (no double posts); every failure is thrown to the caller, which isolates it.
import fs from 'node:fs';
import { env, log } from './lib.js';

const GRAPH = 'https://graph.facebook.com/v26.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(url, opts = {}, timeoutMs = 120000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, body };
}

export async function publishFacebookVideo(file, thumb, title, description) {
  const tok = env.FB_PAGE_TOKEN, page = env.FB_PAGE_ID;
  const size = fs.statSync(file).size;
  // resumable: start → chunks → finish (a 13-min 1080p video is a few hundred MB)
  const start = await call(`https://graph-video.facebook.com/v26.0/${page}/videos`, { method: 'POST',
    body: new URLSearchParams({ upload_phase: 'start', file_size: String(size), access_token: tok }) });
  if (!start.body.upload_session_id) throw new Error('FB start failed: ' + JSON.stringify(start.body).slice(0, 300));
  const sid = start.body.upload_session_id, vid = start.body.video_id;
  let s = Number(start.body.start_offset), e = Number(start.body.end_offset);
  const fd0 = fs.openSync(file, 'r');
  try {
    while (s < e) {
      const buf = Buffer.alloc(e - s); fs.readSync(fd0, buf, 0, e - s, s);
      let res;
      for (let t = 0; t < 4; t++) {
        const fd = new FormData();
        fd.append('upload_phase', 'transfer'); fd.append('upload_session_id', sid); fd.append('start_offset', String(s));
        fd.append('access_token', tok); fd.append('video_file_chunk', new Blob([buf]), 'chunk');
        res = await call(`https://graph-video.facebook.com/v26.0/${page}/videos`, { method: 'POST', body: fd }, 600000).catch(err => ({ body: { error: err.message } }));
        if (res.body.start_offset !== undefined) break;
        await sleep(5000 * (t + 1));
      }
      if (res.body.start_offset === undefined) throw new Error('FB chunk failed: ' + JSON.stringify(res.body).slice(0, 300));
      s = Number(res.body.start_offset); e = Number(res.body.end_offset);
    }
  } finally { fs.closeSync(fd0); }
  const fd = new FormData();
  fd.append('upload_phase', 'finish'); fd.append('upload_session_id', sid); fd.append('access_token', tok);
  fd.append('title', title.slice(0, 250)); fd.append('description', description.slice(0, 5000));
  if (thumb && fs.existsSync(thumb)) fd.append('thumb', new Blob([fs.readFileSync(thumb)], { type: 'image/jpeg' }), 'thumb.jpg');
  const fin = await call(`https://graph-video.facebook.com/v26.0/${page}/videos`, { method: 'POST', body: fd }, 300000);
  // from here the video may be public: never retry
  if (!fin.body.success) throw Object.assign(new Error('FB finish failed: ' + JSON.stringify(fin.body).slice(0, 300)), { maybePosted: true });
  return `https://www.facebook.com/${page}/videos/${vid}`;
}

// Facebook Reel (the cut reel = our "short"): video_reels start → rupload → finish
export async function publishFacebookReel(file, title, description) {
  const tok = env.FB_PAGE_TOKEN, page = env.FB_PAGE_ID;
  const start = await call(`${GRAPH}/${page}/video_reels`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start', access_token: tok }) });
  if (!start.body.video_id) throw new Error('FB reel start failed: ' + JSON.stringify(start.body).slice(0, 300));
  const vid = start.body.video_id;
  const up = await call(`https://rupload.facebook.com/video-upload/v26.0/${vid}`, { method: 'POST', body: fs.readFileSync(file),
    headers: { authorization: 'OAuth ' + tok, offset: '0', file_size: String(fs.statSync(file).size), 'content-type': 'application/octet-stream' } }, 600000);
  if (!up.body.success) throw new Error('FB reel upload failed: ' + JSON.stringify(up.body).slice(0, 300));
  const fin = await call(`${GRAPH}/${page}/video_reels`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'finish', video_id: vid, video_state: 'PUBLISHED', title: title.slice(0, 100),
      description: description.slice(0, 2200), is_ai_generated: true, access_token: tok }) }, 120000);
  if (!fin.body.success) throw Object.assign(new Error('FB reel finish failed: ' + JSON.stringify(fin.body).slice(0, 300)), { maybePosted: true });
  return `https://www.facebook.com/reel/${vid}`;
}

async function instagramOnce(file, caption) {
  const tok = env.FB_PAGE_TOKEN, ig = env.IG_USER_ID;
  const c = await call(`${GRAPH}/${ig}/media`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ media_type: 'REELS', upload_type: 'resumable', caption: caption.slice(0, 2200), share_to_feed: true, thumb_offset: 500, access_token: tok }) });
  if (!c.body.id) throw new Error('IG container failed: ' + JSON.stringify(c.body).slice(0, 300));
  const up = await call(`https://rupload.facebook.com/ig-api-upload/v26.0/${c.body.id}`, { method: 'POST', body: fs.readFileSync(file),
    headers: { authorization: 'OAuth ' + tok, offset: '0', file_size: String(fs.statSync(file).size) } }, 600000);
  if (!up.body.success) throw new Error('IG upload failed: ' + JSON.stringify(up.body).slice(0, 300));
  let st = '';
  for (let k = 0; k < 40 && st !== 'FINISHED'; k++) {
    await sleep(15000);
    st = (await call(`${GRAPH}/${c.body.id}?fields=status_code&access_token=${encodeURIComponent(tok)}`)).body.status_code || '';
    if (st === 'ERROR' || st === 'EXPIRED') throw new Error('IG processing ' + st);
  }
  if (st !== 'FINISHED') throw new Error('IG processing did not finish in 10 min');
  const pub = await call(`${GRAPH}/${ig}/media_publish`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creation_id: c.body.id, access_token: tok }) });
  if (!pub.body.id) throw Object.assign(new Error('IG publish failed: ' + JSON.stringify(pub.body).slice(0, 300)), { maybePosted: true });
  return (await call(`${GRAPH}/${pub.body.id}?fields=permalink&access_token=${encodeURIComponent(tok)}`)).body.permalink || 'https://www.instagram.com/sra_bhakti/';
}

// IG's upload server fails at random (seen on every account): up to 4 tries with a fresh container, never after publish
export async function publishInstagramReel(file, caption) {
  for (let a = 1; ; a++) {
    try { return await instagramOnce(file, caption); } catch (e) {
      if (a >= 4 || e.maybePosted || !/IG (container|upload|processing)/.test(e.message)) throw e;
      log(`instagram try ${a} failed (${e.message.slice(0, 90)}), retry in ${a * 45} s`); await sleep(a * 45000);
    }
  }
}

// Stories (owner 2026-11-03): the reel also goes out as a Facebook Story and an Instagram Story (≤60 s)
export async function publishFacebookStory(file) {
  const tok = env.FB_PAGE_TOKEN, page = env.FB_PAGE_ID;
  const start = await call(`${GRAPH}/${page}/video_stories`, { method: 'POST', body: new URLSearchParams({ upload_phase: 'start', access_token: tok }) });
  if (!start.body.video_id) throw new Error('FB story start failed: ' + JSON.stringify(start.body).slice(0, 300));
  const up = await call(start.body.upload_url || `https://rupload.facebook.com/video-upload/v26.0/${start.body.video_id}`, { method: 'POST',
    body: fs.readFileSync(file), headers: { authorization: 'OAuth ' + tok, offset: '0', file_size: String(fs.statSync(file).size), 'content-type': 'application/octet-stream' } }, 600000);
  if (!up.body.success) throw new Error('FB story upload failed: ' + JSON.stringify(up.body).slice(0, 300));
  const fin = await call(`${GRAPH}/${page}/video_stories`, { method: 'POST',
    body: new URLSearchParams({ upload_phase: 'finish', video_id: start.body.video_id, access_token: tok }) }, 120000);
  if (!fin.body.success) throw Object.assign(new Error('FB story finish failed: ' + JSON.stringify(fin.body).slice(0, 300)), { maybePosted: true });
  return fin.body.post_id ? `https://www.facebook.com/${fin.body.post_id}` : 'posted';
}

export async function publishInstagramStory(file) {
  const tok = env.FB_PAGE_TOKEN, ig = env.IG_USER_ID;
  const c = await call(`${GRAPH}/${ig}/media`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ media_type: 'STORIES', upload_type: 'resumable', access_token: tok }) });
  if (!c.body.id) throw new Error('IG story container failed: ' + JSON.stringify(c.body).slice(0, 300));
  const up = await call(`https://rupload.facebook.com/ig-api-upload/v26.0/${c.body.id}`, { method: 'POST', body: fs.readFileSync(file),
    headers: { authorization: 'OAuth ' + tok, offset: '0', file_size: String(fs.statSync(file).size) } }, 600000);
  if (!up.body.success) throw new Error('IG story upload failed: ' + JSON.stringify(up.body).slice(0, 300));
  let st = '';
  for (let k = 0; k < 40 && st !== 'FINISHED'; k++) {
    await sleep(15000);
    st = (await call(`${GRAPH}/${c.body.id}?fields=status_code&access_token=${encodeURIComponent(tok)}`)).body.status_code || '';
    if (st === 'ERROR' || st === 'EXPIRED') throw new Error('IG story processing ' + st);
  }
  const pub = await call(`${GRAPH}/${ig}/media_publish`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creation_id: c.body.id, access_token: tok }) });
  if (!pub.body.id) throw Object.assign(new Error('IG story publish failed: ' + JSON.stringify(pub.body).slice(0, 300)), { maybePosted: true });
  return 'posted';
}
