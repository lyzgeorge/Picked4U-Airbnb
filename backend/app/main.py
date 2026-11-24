"""FastAPI app: /health, /recommend (extension), /admin (upload + test page)."""
import hmac
import logging
import shutil
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import agent, config, ingest, store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
app = FastAPI(title="Picked 4 U")
app.add_middleware(CORSMiddleware, allow_origin_regex=r"chrome-extension://.*", allow_methods=["*"],
                   allow_headers=["*"])
STATIC = Path(__file__).resolve().parent / "static"


def _check(expected, given):
    if not expected or not given or not hmac.compare_digest(expected, given):
        raise HTTPException(401, "bad token")


def api_auth(x_api_token: str = Header(default="")):
    _check(config.API_TOKEN, x_api_token)


def admin_auth(x_admin_token: str = Header(default="")):
    _check(config.ADMIN_TOKEN, x_admin_token)


class RecommendIn(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    listing_ids: list[str] = Field(max_length=200)
    preference: str = Field(default="", max_length=2000)
    message: str = Field(default="", max_length=500)


@app.get("/health")
def health():
    return {"status": "ok", "reviews": store.count(), "chunks": store.count("chunks"), "fts_index": store.has_fts()}


@app.post("/recommend", dependencies=[Depends(api_auth)])
def recommend(body: RecommendIn):
    ids = list(dict.fromkeys(i for i in body.listing_ids if i.isdigit() and len(i) <= 20))
    return agent.recommend(body.session_id, ids, body.preference.strip(), body.message.strip())


@app.get("/admin")
def admin_page():
    return FileResponse(STATIC / "admin.html")


@app.post("/admin/upload", dependencies=[Depends(admin_auth)])
def upload(file: UploadFile = File(...)):
    if ingest.running():
        raise HTTPException(409, "a job is already running")
    config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    path = config.UPLOAD_DIR / f"{uuid.uuid4().hex[:8]}.csv"
    with path.open("wb") as out:
        shutil.copyfileobj(file.file, out, length=1 << 20)
    return {"job_id": ingest.start(path)}


@app.post("/admin/chunks", dependencies=[Depends(admin_auth)])
def build_chunks():
    """Embed sentence chunks for reviews already in the database (e.g. after upgrading)."""
    if ingest.running():
        raise HTTPException(409, "a job is already running")
    return {"job_id": ingest.start_chunks()}


@app.post("/admin/reindex", dependencies=[Depends(admin_auth)])
def reindex():
    if ingest.running():
        raise HTTPException(409, "a job is already running")
    return {"job_id": ingest.start_reindex()}


@app.get("/admin/jobs/{job_id}", dependencies=[Depends(admin_auth)])
def job(job_id: str):
    if job_id not in ingest.jobs:
        raise HTTPException(404, "no such job")
    return ingest.jobs[job_id]
