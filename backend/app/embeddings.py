"""SiliconFlow embeddings (OpenAI-compatible /embeddings) and optional /rerank."""
import logging
import time

import httpx
import numpy as np

from . import config

log = logging.getLogger("embeddings")

_client = httpx.Client(timeout=60)


def _post(path, payload):
    """POST with retry and exponential backoff on 429 / 5xx / network errors."""
    headers = {"Authorization": f"Bearer {config.SILICONFLOW_API_KEY}"}
    for attempt in range(6):
        try:
            r = _client.post(config.SILICONFLOW_BASE_URL + path, json=payload, headers=headers)
            if r.status_code == 429 or r.status_code >= 500:
                raise httpx.HTTPStatusError(f"{r.status_code}", request=r.request, response=r)
            r.raise_for_status()
            return r.json()
        except (httpx.HTTPStatusError, httpx.TransportError) as err:
            status = getattr(getattr(err, "response", None), "status_code", None)
            if status is not None and 400 <= status < 500 and status != 429 or attempt == 5:
                raise
            log.warning("embedding retry %d after %s", attempt + 1, status or type(err).__name__)
            time.sleep(min(2 ** attempt, 30))


def embed(texts):
    """Embed a list of strings; returns an (n, 1024) float32 array of unit-length vectors."""
    out = []
    for i in range(0, len(texts), config.EMBED_BATCH):
        data = _post("/embeddings", {"model": config.EMBED_MODEL, "input": texts[i:i + config.EMBED_BATCH],
                                     "encoding_format": "float"})["data"]
        out.extend(d["embedding"] for d in sorted(data, key=lambda d: d["index"]))
    vecs = np.asarray(out, dtype=np.float32)
    return vecs / np.linalg.norm(vecs, axis=1, keepdims=True)


def rerank(query, docs):
    """Relevance score per doc (same order as `docs`). Only called when RERANK_MODEL is set."""
    res = _post("/rerank", {"model": config.RERANK_MODEL, "query": query, "documents": docs,
                            "return_documents": False})["results"]
    scores = [0.0] * len(docs)
    for r in res:
        scores[r["index"]] = r["relevance_score"]
    return scores
