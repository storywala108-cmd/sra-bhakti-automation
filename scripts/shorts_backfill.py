"""Scene start times for an already-rendered video (made before Shorts existed), from Whisper word timings.
Usage: python -I shorts_backfill.py <final.mp4> <script.json> <out scenes.json>"""
import difflib, json, re, sys
from faster_whisper import WhisperModel

video, script_file, out = sys.argv[1:4]
s = json.load(open(script_file, encoding="utf-8"))
scenes = [x["text"] for c in s["chapters"] for x in c["scenes"]]
norm = lambda w: re.sub(r"[^a-z0-9']", "", w.lower())
m = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=8)
segs, _ = m.transcribe(video, language="en", word_timestamps=True, beam_size=1)
heard = [(norm(w.word), w.start, w.end) for sg in segs for w in sg.words if norm(w.word)]
words, owner = [], []
for i, t in enumerate(scenes):
    for w in t.split():
        if norm(w):
            words.append(norm(w)); owner.append(i)
sm = difflib.SequenceMatcher(a=words, b=[h[0] for h in heard], autojunk=False)
pos = [None] * len(words)
for a, b, n in sm.get_matching_blocks():
    for k in range(n):
        pos[a + k] = b + k
res = []
for i, t in enumerate(scenes):
    hits = [pos[k] for k in range(len(words)) if owner[k] == i and pos[k] is not None]
    res.append({"text": t, "start": heard[min(hits)][1] if hits else None, "end": heard[max(hits)][2] if hits else None})
for i, r in enumerate(res):           # fill gaps from neighbours
    if r["start"] is None:
        r["start"] = res[i - 1]["end"] if i else 0.0
        r["end"] = r["start"] + 8
for r in res:
    r["vo"] = round(r["end"] - r["start"] + 0.3, 2); r["start"] = round(max(0, r["start"] - 0.15), 2)
json.dump(res, open(out, "w", encoding="utf-8"), indent=1)
print(len(res), "scenes, matched", round(sum(p is not None for p in pos) / max(1, len(pos)), 3))
