"""LanceDB tables.

- `reviews`: one row per review (full text). Used for de-duplication and to show the full review.
- `chunks`:  one row per sentence / clause of a review, with its embedding. This is what we search:
  a short detail ("Fast WiFi") inside a long review matches much better on its own than as part of
  the whole review, and short generic reviews no longer win just by being short.
"""
import os
import re
import threading
import warnings
from datetime import timedelta

os.environ.setdefault("LANCE_LOG", "error")  # hide Lance's per-query deprecation warnings

import lancedb
import numpy as np
import pyarrow as pa
from lancedb.rerankers import RRFReranker

from . import config

VEC = pa.list_(pa.float32(), config.EMBED_DIM)
SCHEMAS = {
    "reviews": pa.schema([("id", pa.string()), ("listing_id", pa.string()), ("date", pa.string()),
                          ("comments", pa.string()), ("vector", VEC)]),
    "chunks": pa.schema([("id", pa.string()), ("review_id", pa.string()), ("listing_id", pa.string()),
                         ("date", pa.string()), ("text", pa.string()), ("vector", VEC)]),
}
_ID = re.compile(r"^\d{1,20}(:\d+)?$")
_lock = threading.Lock()
_tables = {}


def table(name="reviews"):
    with _lock:
        if name not in _tables:
            # re-check for new data every few seconds (another process may be ingesting)
            db = lancedb.connect(config.LANCE_PATH, read_consistency_interval=timedelta(seconds=5))
            _tables[name] = db.create_table(name, schema=SCHEMAS[name], exist_ok=True)
        return _tables[name]


def _in_list(ids):
    """SQL IN list built only from digit-only ids, so nothing can be injected."""
    safe = [i for i in ids if _ID.match(i)]
    return "(" + ",".join(f"'{i}'" for i in safe) + ")" if safe else None


def split_chunks(text, max_len=60, min_len=12, cap=12):
    """Split a review into sentences; long sentences are split again at commas/semicolons/dashes and
    neighbouring parts re-joined up to `max_len` characters. Tiny pieces ("Great!") join a neighbour."""
    text = " ".join(re.sub(r"<br\s*/?>", " ", text).split())
    out = []
    for s in re.split(r"(?<=[.!?…])\s+", text):
        if len(s) <= max_len:
            parts = [s]
        else:
            parts, cur = [], ""
            for p in re.split(r"(?<=[,;])\s+|\s+[-–—]\s+", s):
                if cur and len(cur) + 1 + len(p) > max_len:
                    parts.append(cur)
                    cur = p
                else:
                    cur = f"{cur} {p}".strip()
            parts.append(cur)
        for p in (p.strip() for p in parts):
            if not p:
                continue
            if out and len(out[-1]) < min_len:   # previous piece was tiny: join forward
                out[-1] = f"{out[-1]} {p}"
            elif out and len(p) < min_len:       # this piece is tiny: join backward
                out[-1] = f"{out[-1]} {p}"
            else:
                out.append(p)
    return out[:cap] or [text[:300]]


def count(name="reviews"):
    return table(name).count_rows()


def has_fts(name="chunks"):
    return any(i.index_type == "FTS" for i in table(name).list_indices())


def existing_ids(ids, name="reviews", column="id"):
    sql = _in_list(ids)
    if not sql:
        return set()
    got = table(name).search().where(f"{column} IN {sql}").select([column]).limit(len(ids) * 20).to_arrow()
    return set(got[column].to_pylist())


def insert(rows, name="reviews"):
    """rows: list of dicts matching the table schema. Existing ids are left untouched."""
    if rows:
        table(name).merge_insert("id").when_not_matched_insert_all().execute(
            pa.Table.from_pylist(rows, SCHEMAS[name]))


def finalize():
    """Build the BM25 index on chunk text and scalar indexes on listing_id / review id (after each ingest)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        table("chunks").create_fts_index("text", replace=True)
        table("chunks").create_scalar_index("listing_id", replace=True)
        table("reviews").create_scalar_index("listing_id", replace=True)
        table("reviews").create_scalar_index("id", replace=True)


def full_reviews(review_ids):
    """review id -> {text, date}."""
    sql = _in_list(review_ids)
    if not sql:
        return {}
    got = (table("reviews").search().where(f"id IN {sql}").select(["id", "comments", "date"])
           .limit(len(review_ids)).to_list())
    return {r["id"]: {"text": r["comments"], "date": r["date"]} for r in got}


def search(vec, text, listing_ids, n=150):
    """Hybrid (vector + BM25) search over sentence chunks inside the given listings.

    Returns one hit per review: its best-matching chunk, the cosine similarity of that chunk to `vec`,
    whether BM25 also matched it, and the full review text (for snippets)."""
    sql = _in_list(listing_ids)
    if not sql:
        return []
    tbl, fts = table("chunks"), has_fts()
    if fts:
        q = (tbl.search(query_type="hybrid").vector(vec.tolist()).text(text).distance_type("cosine")
             .rerank(RRFReranker(return_score="all")))
    else:  # index not built yet: vector only
        q = tbl.search(vec.tolist()).distance_type("cosine")
    rows = (q.where(f"listing_id IN {sql}", prefilter=True).limit(n)
            .select(["review_id", "listing_id", "date", "text", "vector"]).to_list())
    best = {}
    for r in rows:
        sim = float(np.asarray(r["vector"], dtype=np.float32) @ vec)
        bm25 = r.get("_score") is not None and r["_score"] == r["_score"]
        h = best.get(r["review_id"])
        if h is None or sim > h["sim"]:
            best[r["review_id"]] = {"review_id": r["review_id"], "listing_id": r["listing_id"], "date": r["date"],
                                    "chunk": r["text"], "sim": sim, "bm25": bm25 or (h or {}).get("bm25", False)}
        elif bm25:
            h["bm25"] = True
    full = full_reviews(list(best))
    for rid, h in best.items():
        h["text"] = full.get(rid, {}).get("text", h["chunk"])
    return list(best.values())


def chunk_vectors(listing_ids):
    """All chunk vectors of these listings: (listing ids, review ids, (n, dim) matrix). For the avoid penalty."""
    sql = _in_list(listing_ids)
    if not sql:
        return [], [], np.zeros((0, config.EMBED_DIM), dtype=np.float32)
    got = (table("chunks").search().where(f"listing_id IN {sql}").select(["listing_id", "review_id", "vector"])
           .limit(500_000).to_arrow())
    owners = got["listing_id"].to_pylist()
    mat = np.asarray(got["vector"].to_pylist(), dtype=np.float32).reshape(len(owners), config.EMBED_DIM)
    return owners, got["review_id"].to_pylist(), mat
