"""Index only the reviews of some listings (quick start before the full upload). Run from backend/:
    .venv/bin/python -m scripts.ingest_ids path/to/reviews.csv ID [ID ...]
The 2-year window is still relative to the newest review in the FULL file.
"""
import sys
import tempfile
import time

import pandas as pd

from app import ingest, store

csv, ids = sys.argv[1], set(sys.argv[2:])
df = pd.read_csv(csv, dtype={"listing_id": str, "id": str, "date": str})
max_date = df["date"].max()
sub = df[df["listing_id"].isin(ids)]
tmp = tempfile.NamedTemporaryFile(suffix=".csv", delete=False).name
sub.to_csv(tmp, index=False)
print(f"{len(sub)} reviews for {sub.listing_id.nunique()}/{len(ids)} listings; newest review in file {max_date}")

job = ingest.start(tmp, max_date)
while ingest.jobs[job]["status"] not in ("done", "error"):
    time.sleep(2)
    print("\r", ingest.jobs[job], end="", flush=True)
print("\n", ingest.jobs[job], "| table rows:", store.count(), "| fts:", store.has_fts())
