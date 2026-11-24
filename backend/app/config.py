"""Settings read once from environment variables (docker compose loads backend/.env)."""
import os
from pathlib import Path


def _load_dotenv():
    """For local runs without Docker: read backend/.env if it exists (never overrides real env vars)."""
    path = Path(__file__).resolve().parent.parent / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.split(" #")[0].strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()


def _get(name, default=""):
    return os.environ.get(name, default).strip()


API_TOKEN = _get("API_TOKEN")
ADMIN_TOKEN = _get("ADMIN_TOKEN")
SILICONFLOW_BASE_URL = _get("SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1").rstrip("/")
SILICONFLOW_API_KEY = _get("SILICONFLOW_API_KEY")
EMBED_MODEL = _get("EMBED_MODEL", "BAAI/bge-m3")
EMBED_BATCH = int(_get("EMBED_BATCH", "32"))
RERANK_MODEL = _get("RERANK_MODEL")
LLM_PROTOCOL = _get("LLM_PROTOCOL", "openai_responses")  # openai_responses | anthropic_messages | google_genai
LLM_BASE_URL = _get("LLM_BASE_URL") or None
LLM_API_KEY = _get("LLM_API_KEY")
LLM_MODEL = _get("LLM_MODEL")
LLM_REASONING_EFFORT = _get("LLM_REASONING_EFFORT", "none")  # openai_responses + google_genai; empty = model default
REVIEW_YEARS = int(_get("REVIEW_YEARS", "2"))
SIM_THRESHOLD = float(_get("SIM_THRESHOLD", "0.66"))  # cosine of best review sentence vs wish
BM25_SLACK = float(_get("BM25_SLACK", "0.04"))  # keyword matches may be this much below the threshold
AVOID_SIM = float(_get("AVOID_SIM", "0.60"))
AVOID_PENALTY = float(_get("AVOID_PENALTY", "1.0"))
LANCE_PATH = _get("LANCE_PATH", str(Path(__file__).resolve().parent.parent / "data" / "lancedb"))
UPLOAD_DIR = Path(LANCE_PATH).parent / "uploads"

EMBED_DIM = 1024   # bge-m3
TOP_K = 5          # listings shown in the row
MIN_ITEMS = 3      # fewer than this triggers the one retry
MAX_TURNS = 10
