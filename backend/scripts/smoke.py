"""Check the provider keys: one embedding call and one LLM JSON call. Run from backend/:
    .venv/bin/python -m scripts.smoke
"""
import numpy as np

from app import config, embeddings
from app.llm import parse_json

v = embeddings.embed(["quiet room, slept really well", "very peaceful at night", "the kitchen had no kettle"])
print("embedding shape", v.shape, "(expect (3, 1024))")
print(f"related cosine {v[0] @ v[1]:.3f} > unrelated {v[0] @ v[2]:.3f}:", v[0] @ v[1] > v[0] @ v[2])
if config.RERANK_MODEL:
    print("rerank", embeddings.rerank("quiet", ["very peaceful at night", "no kettle"]))
out = parse_json("Reply with JSON only.", 'Return {"ok": true, "protocol": "<your guess>"}')
print(f"LLM ({config.LLM_PROTOCOL}, {config.LLM_MODEL}) ->", out)
