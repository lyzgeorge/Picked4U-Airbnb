"""Embed sentence chunks for reviews already in the database. Run from backend/:
    .venv/bin/python -m scripts.build_chunks [ids_file]     # no file = all reviews
"""
import logging
import sys
import time

from app import ingest, store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

ids = open(sys.argv[1]).read().split() if len(sys.argv) > 1 else None
job = ingest.start_chunks(ids)
while ingest.jobs[job]["status"] not in ("done", "error"):
    time.sleep(3)
    print("\r", ingest.jobs[job], end="", flush=True)
print("\n", ingest.jobs[job], "| chunks:", store.count("chunks"), "| fts:", store.has_fts())
