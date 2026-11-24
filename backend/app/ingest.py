"""Background jobs. Both are safe to rerun: rows that already exist are skipped.

- start(csv):      reviews CSV -> filter -> store full reviews + embed their sentence chunks.
- start_chunks():  build the sentence chunks for reviews already in the `reviews` table (no CSV needed).
"""
import logging
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor

import httpx
import pandas as pd

from . import config, embeddings, store

log = logging.getLogger("ingest")
COLS = ["listing_id", "id", "date", "comments"]
CHUNK = 50_000
GROUP = 1_000      # reviews handled together
WORKERS = 8        # parallel embedding requests

jobs = {}          # job_id -> {status, done, total, skipped, error}


def running():
    return any(j["status"] in ("queued", "running", "indexing") for j in jobs.values())


def _chunks(path):
    return pd.read_csv(path, usecols=COLS, dtype={"listing_id": str, "id": str, "date": str,
                                                  "comments": str}, chunksize=CHUNK)


def _filter(df, cutoff):
    df = df.dropna(subset=["listing_id", "id", "date"]).copy()
    df["comments"] = df["comments"].fillna("").str.replace(r"<br\s*/?>", " ", regex=True).str.strip()
    df = df[(df["comments"].str.len() >= 20) & (df["date"] >= cutoff)]
    df["comments"] = df["comments"].str.slice(0, 1000)
    return df


def _embed_safe(texts):
    """Embed a batch; if the API rejects it (4xx), split it in half and retry, down to single texts.
    A single text that is still rejected gets None (and is skipped) instead of stopping the whole job."""
    try:
        return list(embeddings.embed(texts))
    except httpx.HTTPStatusError as err:
        if err.response.status_code >= 500 or err.response.status_code == 429:
            raise
        if len(texts) == 1:
            log.warning("skipping text the embedding API rejects (%s): %r", err.response.text[:120], texts[0][:80])
            return [None]
        mid = len(texts) // 2
        return _embed_safe(texts[:mid]) + _embed_safe(texts[mid:])


def _embed_all(pool, texts):
    step = config.EMBED_BATCH
    parts = pool.map(_embed_safe, [texts[i:i + step] for i in range(0, len(texts), step)])
    return [v for part in parts for v in part]


def _store_chunks(pool, reviews):
    """reviews: list of dicts {id, listing_id, date, comments}. Embeds and stores their sentence chunks."""
    rows = [{"id": f"{r['id']}:{k}", "review_id": r["id"], "listing_id": r["listing_id"], "date": r["date"],
             "text": t} for r in reviews for k, t in enumerate(store.split_chunks(r["comments"]))]
    if rows:
        for row, v in zip(rows, _embed_all(pool, [r["text"] for r in rows])):
            row["vector"] = None if v is None else v.tolist()
        store.insert([r for r in rows if r["vector"] is not None], "chunks")


def _run(job, path, max_date=None):
    try:
        job["status"] = "running"
        max_date = max_date or max(c["date"].dropna().max() for c in _chunks(path))
        cutoff = (pd.Timestamp(max_date) - pd.DateOffset(years=config.REVIEW_YEARS)).strftime("%Y-%m-%d")
        job["total"] = sum(len(_filter(c, cutoff)) for c in _chunks(path))
        log.info("max date %s, cutoff %s, %d reviews to index", max_date, cutoff, job["total"])

        with ThreadPoolExecutor(WORKERS) as pool:
            for chunk in _chunks(path):
                df = _filter(chunk, cutoff)
                for start in range(0, len(df), GROUP):
                    group = df.iloc[start:start + GROUP]
                    have = store.existing_ids(group["id"].tolist())
                    todo = group[~group["id"].isin(have)]
                    job["skipped"] += len(group) - len(todo)
                    if len(todo):
                        recs = todo[["id", "listing_id", "date", "comments"]].to_dict("records")
                        # chunks first: if the job stops in between, the review is redone next time
                        _store_chunks(pool, recs)
                        vecs = _embed_all(pool, todo["comments"].tolist())
                        store.insert([{**r, "vector": v.tolist()} for r, v in zip(recs, vecs) if v is not None])
                    job["done"] += len(group)

        job["status"] = "indexing"
        store.finalize()
        job["status"] = "done"
        log.info("ingest done: %s", job)
    except Exception as err:
        job.update(status="error", error=str(err))
        log.error("ingest failed: %s", traceback.format_exc())


def _run_chunks(job, listing_ids=None):
    """Chunk + embed every review in `reviews` that has no chunks yet (optionally only some listings)."""
    try:
        job["status"] = "running"
        q = store.table("reviews").search()
        if listing_ids:
            q = q.where(f"listing_id IN {store._in_list(listing_ids)}")
        reviews = q.select(["id", "listing_id", "date", "comments"]).limit(10_000_000).to_list()
        job["total"] = len(reviews)
        log.info("building chunks for %d reviews", len(reviews))
        with ThreadPoolExecutor(WORKERS) as pool:
            for start in range(0, len(reviews), GROUP * 4):  # bigger groups: fewer waits on the slowest call
                group = reviews[start:start + GROUP * 4]
                have = store.existing_ids([r["id"] for r in group], "chunks", "review_id")
                todo = [r for r in group if r["id"] not in have]
                job["skipped"] += len(group) - len(todo)
                t0 = time.time()
                _store_chunks(pool, todo)
                job["done"] += len(group)
                log.info("chunks: %d/%d reviews, group of %d took %.0fs", job["done"], job["total"], len(todo),
                         time.time() - t0)
        job["status"] = "indexing"
        store.finalize()
        job["status"] = "done"
        log.info("chunks done: %s (%d chunks)", job, store.count("chunks"))
    except Exception as err:
        job.update(status="error", error=str(err))
        log.error("chunk job failed: %s", traceback.format_exc())


def _start(target, *args):
    job_id = uuid.uuid4().hex[:8]
    jobs[job_id] = {"status": "queued", "done": 0, "total": 0, "skipped": 0, "error": None}
    threading.Thread(target=target, args=(jobs[job_id], *args), daemon=True).start()
    return job_id


def start(path, max_date=None):
    return _start(_run, path, max_date)


def start_chunks(listing_ids=None):
    return _start(_run_chunks, listing_ids)


def start_reindex():
    """Rebuild the indexes only (e.g. after a crashed job)."""
    def run(job):
        try:
            job["status"] = "indexing"
            store.finalize()
            job["status"] = "done"
        except Exception as err:
            job.update(status="error", error=str(err))
    return _start(run)
