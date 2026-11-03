// one-off: brand artwork (FLUX.2 klein 4B, Apache-2.0) for SRA Bhakti Channel
const fs = require('fs'), path = require('path');
const envFile = process.env.ENV_FILE || path.join(__dirname, '../../.env');
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const STYLE = 'rich devotional Indian painting, glowing golden divine light, saffron, deep maroon and gold colours, detailed, cinematic soft lighting, absolutely no text, letters or watermark';
const jobs = {
  emblem: 'a radiant golden lotus flower floating on calm water with a small glowing oil diya lamp at its centre and a white conch shell beside it, temple bells hanging above, centered emblem, dark maroon background with soft golden halo, lots of empty space around',
  scene_left: 'an ancient Indian stone temple on a river bank at sunrise, oil lamps floating on the water, golden sky, birds, peaceful divine atmosphere',
  scene_right: 'a mythological battle in the sky between radiant celestial warriors with glowing weapons and huge dark demon silhouettes among storm clouds and lightning, epic scale, seen from far away',
};
(async () => {
  for (const [name, prompt] of Object.entries(jobs)) {
    if (process.argv[2] && process.argv[2] !== name) continue;
    const fd = new FormData(); fd.append('prompt', `${prompt}. ${STYLE}`); fd.append('width', '1024'); fd.append('height', '1024');
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`, { method: 'POST', headers: { Authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN }, body: fd });
    const j = await r.json();
    if (!j.result?.image) { console.log(name, 'FAILED', JSON.stringify(j.errors).slice(0, 150)); continue; }
    fs.writeFileSync(path.join(__dirname, name + '.png'), Buffer.from(j.result.image, 'base64')); console.log(name, 'ok');
  }
})();
