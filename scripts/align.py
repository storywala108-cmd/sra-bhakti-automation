"""Cut one narration chunk into per-scene WAVs using faster-whisper word timestamps.
Usage: python -I align.py <chunk.wav> <scenes.json> <out_prefix>
scenes.json = ["scene text", ...] in spoken order. Writes <out_prefix>000.wav, 001.wav ... and prints the cut times.
Cuts land in the silence between the last word of one scene and the first word of the next."""
import difflib, json, re, subprocess, sys, wave

wav, scenes_file, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
scenes = json.load(open(scenes_file, encoding="utf-8"))
# Hindi: Whisper small misspells matras/nukta (वीडियो→वीरियो), so words are compared by their consonant skeleton
# (vowel signs, nukta, anusvara, chandrabindu, visarga, halant removed) — far more script words find their anchor.
SKEL = re.compile(r"[़ा-्ऀ-ःॢॣ]")
norm = lambda w: SKEL.sub("", re.sub(r"[^ऀ-ॿa-z0-9]", "", w.lower()))

from faster_whisper import WhisperModel
model = WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=4)
segs, _ = model.transcribe(wav, language="hi", word_timestamps=True, beam_size=1, vad_filter=False)
heard = [(norm(w.word), w.start, w.end) for s in segs for w in s.words if norm(w.word)]

script_words, owner = [], []
for i, t in enumerate(scenes):
    for w in t.split():
        if norm(w):
            script_words.append(norm(w)); owner.append(i)

# map every script word to a heard word (difflib handles small transcription differences)
sm = difflib.SequenceMatcher(a=script_words, b=[h[0] for h in heard], autojunk=False)
pos = [None] * len(script_words)
for a, b, n in sm.get_matching_blocks():
    for k in range(n):
        pos[a + k] = b + k
with wave.open(wav) as f:
    total = f.getnframes() / f.getframerate()

cuts = []
for i in range(1, len(scenes)):
    last = [pos[k] for k in range(len(script_words)) if owner[k] == i - 1 and pos[k] is not None]
    first = [pos[k] for k in range(len(script_words)) if owner[k] == i and pos[k] is not None]
    if last and first:
        cuts.append((heard[max(last)][2] + heard[min(first)][1]) / 2)
    else:   # no anchor: split by the scenes' share of words
        done = sum(len(scenes[j].split()) for j in range(i)) / max(1, sum(len(s.split()) for s in scenes))
        cuts.append(total * done)
cuts = [0.0] + sorted(cuts) + [total]
for i in range(len(scenes)):
    a, b = cuts[i], cuts[i + 1]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-ss", f"{a:.3f}", "-to", f"{b:.3f}",
                    f"{prefix}{i:03d}.wav"], check=True)   # no fades: clips are joined back seamlessly
matched = sum(p is not None for p in pos) / max(1, len(pos))
print(json.dumps({"cuts": [round(c, 2) for c in cuts], "matched": round(matched, 3)}))
