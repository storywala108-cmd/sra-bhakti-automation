// Connection test: uploads a short PRIVATE clip and reads channel analytics. Never prints secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(l => /^\w+=/.test(l))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);
const file = process.argv[2];

const tok = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET,
    refresh_token: env.YT_REFRESH_TOKEN, grant_type: 'refresh_token',
  }),
}).then(r => r.json());
if (!tok.access_token) { console.log('TOKEN FAILED', tok.error); process.exit(1); }
const auth = { authorization: `Bearer ${tok.access_token}` };

const size = fs.statSync(file).size;
const start = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json', 'x-upload-content-length': String(size), 'x-upload-content-type': 'video/mp4' },
  body: JSON.stringify({
    snippet: { title: 'Connection test (private)', description: 'Automation connection test.', categoryId: '27' },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
  }),
});
const loc = start.headers.get('location');
if (!loc) { console.log('UPLOAD START FAILED', start.status, await start.text()); process.exit(1); }
const up = await fetch(loc, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: fs.readFileSync(file) }).then(r => r.json());
console.log('UPLOADED', up.id ? `https://youtu.be/${up.id} status=${up.status?.privacyStatus}` : JSON.stringify(up.error));

const today = new Date().toISOString().slice(0, 10);
const an = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=2026-10-01&endDate=${today}&metrics=views,estimatedMinutesWatched`, { headers: auth }).then(r => r.json());
console.log('ANALYTICS', an.error ? `error ${an.error.code} ${an.error.message}` : `ok rows=${JSON.stringify(an.rows || [])}`);
