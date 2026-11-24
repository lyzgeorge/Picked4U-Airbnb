"""Print cosine similarities for on-topic and off-topic fragments over the test listings,
to choose SIM_THRESHOLD. Run from backend/ after ingest:  .venv/bin/python -m scripts.calibrate
"""
from pathlib import Path

import numpy as np

from app import embeddings, store

import sys
IDS = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("test_ids.txt")).read_text().split()
FRAGMENTS = ["quiet at night, slept well", "walking distance to pubs and bars", "near the Luas",
             "spotlessly clean", "fast wifi and a good desk", "host replied quickly",
             "ski-in ski-out chalet", "private beach access"]   # last two should match nothing
THRESHOLDS = [0.45, 0.50, 0.55, 0.60, 0.65, 0.70]

vecs = embeddings.embed(FRAGMENTS)
print(f"{'fragment':38} {'max':>5} {'p90':>5}  listings with >=2 reviews at " + " ".join(f"{t:.2f}" for t in THRESHOLDS))
for f, v in zip(FRAGMENTS, vecs):
    hits = store.search(v, f, IDS, n=200)
    sims = np.array([h["sim"] for h in hits]) if hits else np.zeros(1)
    counts = []
    for t in THRESHOLDS:
        per = {}
        for h in hits:
            if h["sim"] >= t:
                per[h["listing_id"]] = per.get(h["listing_id"], 0) + 1
        counts.append(sum(n >= 2 for n in per.values()))
    bm25 = sum(h["bm25"] for h in hits)
    print(f"{f[:38]:38} {sims.max():5.2f} {np.percentile(sims, 90):5.2f}  "
          + " ".join(f"{c:4d}" for c in counts) + f"   (bm25 hits: {bm25})")
    best = max(hits, key=lambda h: h["sim"]) if hits else None
    if best:
        print(f"    best: {best['sim']:.2f} {best['text'][:110]!r}")
print("\nPick the lowest threshold where the last two (off-topic) rows show 0 listings.")
