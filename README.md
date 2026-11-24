# Picked 4 U — Airbnb recommendation extension (demo)

The Chrome extension "Picked 4 U" adds a row of picks to Airbnb search results (between the 2nd and
3rd listing). A small backend matches what you like against past guest reviews, using LanceDB hybrid search
(vector + BM25) over bge-m3 embeddings. It returns 3–5 listings, each with a short reason. Candidates are the current
page plus the other pages linked in Airbnb's pagination bar (on page 1: pages 2–4; the "Last page" jump only counts once
it is next door). Those pages are fetched in the background and cached for the tab; picks from them link straight
to the listing and show "· page N".
Design: [`plan.md`](plan.md). Work plan: [`dev-plan.md`](dev-plan.md).

```text
backend/    FastAPI + LanceDB (Docker)       extension/   Manifest V3, plain JS, no build step
```

## 1. Configure

```bash
cp backend/.env.example backend/.env    # then fill it in
```

| Variable | What to put |
|---|---|
| `API_TOKEN`, `ADMIN_TOKEN` | Any long random strings (`openssl rand -hex 16`) |
| `SILICONFLOW_API_KEY` | Your SiliconFlow key (embeddings, `BAAI/bge-m3`) |
| `LLM_PROTOCOL` | `openai_responses`, `anthropic_messages`, or `google_genai` (Gemini with an AI Studio key) |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Your LLM endpoint. Leave `LLM_BASE_URL` empty for the official API |
| `LLM_REASONING_EFFORT` | `none` (default, fastest: ~12–15 s per request), `low`, `medium`, `high`. For Gemini, `none` = minimal thinking |
| `SIM_THRESHOLD`, `AVOID_SIM` | `0.66` / `0.72` were calibrated on the Dublin sentence chunks (step 3) |
| `LANCE_PATH` | Docker sets its own. For a local run, start the server with `LANCE_PATH=$PWD/data/lancedb` |

Gemini example (AI Studio key from https://aistudio.google.com/apikey):
```env
LLM_PROTOCOL=google_genai
LLM_BASE_URL=                 # empty = Google's official endpoint
LLM_API_KEY=<your AI Studio key>
LLM_MODEL=<a Gemini model id from AI Studio>
```

## 2. Run the backend

**Docker:** `docker compose up -d --build`, then open `http://localhost:8000/health`.

**Local (no Docker):**
```bash
cd backend
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -m scripts.smoke          # checks the embedding + LLM keys
.venv/bin/uvicorn app.main:app --port 8000
```
Locally, data is stored in `backend/data/` (gitignored).

## 3. Load the reviews

Quick start: index only the listings on one search page (≈4k reviews, under a minute), from `backend/`:
`.venv/bin/python -m scripts.ingest_ids ../../dublin-data/reviews.csv $(cat scripts/page_ids.txt)`

1. Full data: open `http://localhost:8000/admin`, enter the admin token and upload `../dublin-data/reviews.csv`.
   The job keeps the last 2 years of reviews of 20+ characters (≈160k reviews; this takes a while because of
   embedding calls). It's safe to re-upload: existing reviews are skipped, so an interrupted job can be restarted.
   Each review is also split into sentences, which are embedded separately (~4.4 per review, ~710k for Dublin; about 80 minutes at SiliconFlow's ~150 texts/s). Upgrading an existing database: `.venv/bin/python -m scripts.build_chunks` or the "Build sentence chunks" button on `/admin`.
2. Calibrate the thresholds once (from `backend/`): `.venv/bin/python -m scripts.calibrate [ids_file]`. In Docker:
   `docker compose exec backend python -m scripts.calibrate`. Choose the lowest `SIM_THRESHOLD` where the
   off-topic rows (ski chalet, beach) show 0 listings. Put it in `.env` and restart.
3. Test: `API_TOKEN=... IDS_FILE=scripts/page_ids.txt ./scripts/test_recommend.sh` (from `backend/`) (three presets, an off-topic message and an
   impossible preference). Or use the "Try a query" box on `/admin`.

## 4. Load the extension

1. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → choose `extension/`.
2. Click the extension icon. Under **Connection**, set the backend URL (`http://localhost:8000` or your HTTPS domain)
   and the API token. Write a preference or pick a preset.
3. Search Dublin on airbnb.ie. The row appears after the 2nd result.

To use a deployed domain, either add it to `host_permissions` in `extension/manifest.json` or rely on the
backend's CORS rule, which allows `chrome-extension://*`.

## Deploying

Run `docker compose up -d` on the server behind your HTTPS reverse proxy. Set its upload limit to ≥150 MB and
its timeout for `/admin/upload` to a few minutes. To skip re-embedding, copy a local `backend/data/lancedb`
folder into the `lance-data` volume.

## Troubleshooting

- **No row:** the extension must be on and there must be a preference. The arrow in the row's corner collapses it
  (remembered across tabs); while collapsed it sends no requests. After reloading the extension, refresh the tab. Check `/health`: `reviews` must be > 0. Errors hide the row silently, so
  check the service worker console in `chrome://extensions`.
- **Always "We didn't find a place…":** `SIM_THRESHOLD` is too high; run the calibration again.
- **Backend logs** show the search fragments and candidate counts for each request (no keys, no review text).
