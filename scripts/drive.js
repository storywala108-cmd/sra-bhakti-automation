// Google Drive queue of ready videos (scope drive.file: only files this app made).
// Folders: "Ink & Crowns Queue" (ready, oldest first) and "Ink & Crowns Published" (uploaded, deleted after 1 day).
import fs from 'node:fs';
import { pipeline as streamPipe } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { env, httpJson } from './lib.js';

const API = 'https://www.googleapis.com/drive/v3';
let cached;
async function token() {
  if (cached && cached.exp > Date.now() + 60000) return cached.t;
  const r = await httpJson('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET,
      refresh_token: env.DRIVE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  cached = { t: r.access_token, exp: Date.now() + r.expires_in * 1000 };
  return cached.t;
}
const H = async (extra = {}) => ({ authorization: `Bearer ${await token()}`, ...extra });
const q = s => encodeURIComponent(s);

export async function folder(name) {
  const f = await httpJson(`${API}/files?q=${q(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)`, { headers: await H() });
  if (f.files[0]) return f.files[0].id;
  const c = await httpJson(`${API}/files?fields=id`, { method: 'POST', headers: await H({ 'content-type': 'application/json' }),
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }) });
  return c.id;
}
export const QUEUE = 'Ink & Crowns Queue';
export const PUBLISHED = 'Ink & Crowns Published';

// Resumable upload in 32 MB chunks (an 18-min 1080p video is ~1 GB); each chunk retried.
export async function uploadFile(localPath, name, parentId, mime = 'application/octet-stream', appProperties = {}) {
  const size = fs.statSync(localPath).size;
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: await H({ 'content-type': 'application/json', 'x-upload-content-type': mime, 'x-upload-content-length': String(size) }),
    body: JSON.stringify({ name, parents: [parentId], appProperties }),
  });
  const loc = start.headers.get('location');
  if (!loc) throw new Error(`drive upload start ${start.status}: ${(await start.text()).slice(0, 200)}`);
  const fd = fs.openSync(localPath, 'r');
  const CH = 32 * 1024 * 1024;
  try {
    for (let off = 0; off < size;) {
      const len = Math.min(CH, size - off);
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, off);
      let r;
      for (let t = 0; t < 4; t++) {
        r = await fetch(loc, { method: 'PUT', headers: { 'content-range': `bytes ${off}-${off + len - 1}/${size}` }, body: buf }).catch(e => ({ status: 0, e }));
        if (r.status === 308 || r.status === 200 || r.status === 201) break;
        await new Promise(x => setTimeout(x, 5000 * (t + 1)));
      }
      if (r.status === 200 || r.status === 201) return (await r.json()).id;
      if (r.status !== 308) throw new Error(`drive chunk failed at ${off}: ${r.status}`);
      const range = r.headers.get('range');               // server tells us how much it really has
      off = range ? Number(range.split('-')[1]) + 1 : off + len;
    }
  } finally { fs.closeSync(fd); }
  throw new Error('drive upload ended without a file id');
}

export async function list(parentId) {
  const r = await httpJson(`${API}/files?q=${q(`'${parentId}' in parents and trashed=false`)}&orderBy=createdTime&pageSize=200` +
    `&fields=files(id,name,size,createdTime,modifiedTime,appProperties)`, { headers: await H() });
  return r.files;
}

export async function download(fileId, localPath) {
  const r = await fetch(`${API}/files/${fileId}?alt=media`, { headers: await H() });
  if (!r.ok) throw new Error(`drive download ${r.status}`);
  await streamPipe(Readable.fromWeb(r.body), fs.createWriteStream(localPath + '.tmp'));
  fs.renameSync(localPath + '.tmp', localPath);
}

export async function move(fileId, fromId, toId, appProperties) {
  await httpJson(`${API}/files/${fileId}?addParents=${toId}&removeParents=${fromId}&fields=id`, {
    method: 'PATCH', headers: await H({ 'content-type': 'application/json' }), body: JSON.stringify(appProperties ? { appProperties } : {}),
  });
}

export async function setProps(fileId, appProperties) {
  await httpJson(`${API}/files/${fileId}?fields=id`, {
    method: 'PATCH', headers: await H({ 'content-type': 'application/json' }), body: JSON.stringify({ appProperties }),
  });
}

// Permanent delete (Drive trash still counts against the 15 GB) — only used 1 day after a confirmed YouTube upload.
export async function remove(fileId) {
  const r = await fetch(`${API}/files/${fileId}`, { method: 'DELETE', headers: await H() });
  if (!r.ok && r.status !== 404) throw new Error(`drive delete ${r.status}`);
}

export async function usage() {
  const r = await httpJson(`${API}/about?fields=storageQuota`, { headers: await H() });
  return { usedGB: Number(r.storageQuota.usage) / 1e9, limitGB: Number(r.storageQuota.limit) / 1e9 };
}
