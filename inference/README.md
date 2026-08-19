# Eclat jewelry embedding service

Self-hosted CPU inference microservice that turns a jewelry image into two
L2-normalized embedding vectors — one from a **DINO** image tower (fine-grained
visual structure / geometry) and one from **SigLIP 2** (semantic). Called by the
Node/NestJS backend over HTTP for catalogue image search (Module 5).

Both vectors are returned so the backend can index each in its own pgvector column
and fuse similarity as it sees fit (structure vs. semantics weigh differently for
"find the same ring" vs. "find similar-looking rings").

## Models chosen

| Slot | Default HF id | Dim | Licence | Why |
|------|---------------|-----|---------|-----|
| DINO (`dino`) | `facebook/dinov2-base` | 768 | **Apache-2.0** | Structure/geometry features. ViT-B/14, CPU-feasible. Ungated → deploys on a fresh Railway container with no token. |
| SigLIP 2 (`siglip`) | `google/siglip2-base-patch16-224` | 768 | **Apache-2.0** | Complementary semantic features (image tower only — we embed images, not text, this phase). Ungated. |

### DINOv3 vs. DINOv2 — the trade-off (read before switching)

The brief asked for **DINOv3** and to fall back to DINOv2 only if the DINOv3
licence is problematic. It is problematic *enough* for an automated CPU deploy that
we default to DINOv2 and leave DINOv3 one env var away:

- **DINOv3** (`facebook/dinov3-vitb16-pretrain-lvd1689m`, released Aug 2025) ships
  under Meta's custom **DINOv3 License**, and the HF repo is **gated** — you must
  accept terms and pass an `HF_TOKEN` for the download to succeed. The licence
  permits commercial use but carries Meta-specific restrictions (acceptable-use +
  attribution) that legal should confirm for this deployment.
- **DINOv2** is plain **Apache-2.0**, ungated, and downloads unattended. For a
  container that must boot without human token-wrangling, that reliability wins.

Pooling (CLS `pooler_output`) is identical across v2 and v3, so **switching is
just config** — no code change:

```
DINO_MODEL_ID=facebook/dinov3-vitb16-pretrain-lvd1689m
HF_TOKEN=hf_xxx        # required: DINOv3 repo is gated
```

> **TODO (legal + swap):** confirm the DINOv3 License is acceptable for CaratSense's
> commercial use, then set the two env vars above and re-index the catalogue
> (vectors change → treat as a new embedding space; keep `preprocessing_version`).

A future `GeminiEmbeddingProvider` (or any other) slots in by subclassing
`EmbeddingProvider` in `app/providers.py` — the service logic never changes.

## Preprocessing (ONE deterministic pipeline, `preprocessing_version = 1`)

Shared by both models; lives in `app/preprocessing.py`. Never touches the source
file — all in memory. Steps: decode (JPEG/PNG/WebP/MPO only) → **EXIF orientation**
→ flatten transparency/palette onto **white** → reject decompression bombs / cap
oversized inputs → **aspect-preserving resize + centre-pad ("letterbox") to a
square** white canvas (default 224).

**Why letterbox, not centre-crop, and no segmentation:** the real Gati catalogue
(`backend/uploads/catalogue/`) is a mix of wide CAD spec-sheets (several views +
dimension text on white) and portrait phone photos of pieces on paper/grey. Content
spans the whole frame and aspect ratios are all over the place — a centre-crop would
slice off half the views. Backgrounds are already light and uniform, so a white pad
adds no edge the models fixate on, and a segmentation model would be cost with no
measurable gain. Revisit segmentation only if busy/coloured backdrops appear.

`image_hash` is a SHA-256 over the *normalized* canvas — a stable, model-independent
dedup / change-detection key. Bump `PREPROCESSING_VERSION` if the pipeline changes.

## HTTP contract

`POST /embed` — `{"image_b64": "<base64>", "mime": "image/jpeg"}` →
```json
{ "dino": [..768..], "siglip": [..768..], "dino_dim": 768, "siglip_dim": 768,
  "model_versions": {"dino": "facebook/dinov2-base", "siglip": "google/siglip2-base-patch16-224"},
  "preprocessing_version": 1, "image_hash": "<sha256>" }
```
Bad/corrupt/unsupported image → `400 {"error": "..."}`; model failure → `500 {"error": "..."}`.
(FastAPI wraps the message as `{"detail": "..."}`; the backend reads `detail`.)

`POST /embed/batch` — `{"images": [{"id","image_b64","mime"}, ...]}` →
`{"results": [{"id","dino","siglip","image_hash"}], "errors": [{"id","error"}]}`.
Per-image errors don't fail the batch. Batched through the model in one forward pass
(efficient for the ~2000-image one-time catalogue index). Cap `MAX_BATCH` (default 64).

`GET /health` → `{"status": "ok"|"degraded", "models": {"dino": {"id","loaded","dim"}, "siglip": {...}}, "preprocessing_version": 1}`.

`GET /metrics` → `{"embed_count","embed_failure","latency_ms_sum","latency_ms_avg"}`.

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8000` | Listen port (Railway injects this). |
| `MODEL_CACHE_DIR` / `HF_HOME` | HF default | Where weights are cached — point at a mounted Railway volume so they persist across deploys. |
| `INFERENCE_API_KEY` | *(unset)* | If set, `/embed` and `/embed/batch` require `Authorization: Bearer <key>`. |
| `DINO_MODEL_ID` | `facebook/dinov2-base` | Swap in DINOv3 (see above). |
| `SIGLIP_MODEL_ID` | `google/siglip2-base-patch16-224` | Override SigLIP variant. |
| `HF_TOKEN` | *(unset)* | Required only for gated models (DINOv3). |
| `PREPROCESS_SIZE` | `224` | Square canvas size. |
| `MAX_BATCH` | `64` | Max images per `/embed/batch`. |
| `TORCH_NUM_THREADS` | `#cpus` | CPU thread cap. |
| `LOG_LEVEL` | `INFO` | Logging level. |

No raw image bytes are ever logged — only hashes, dims, and latency.

## Run locally

```bash
cd inference
python -m venv .venv && . .venv/Scripts/activate   # Windows; use bin/activate on *nix
pip install -r requirements.txt
export MODEL_CACHE_DIR=./models          # first run downloads ~0.7 GB of weights
uvicorn app.main:app --host 0.0.0.0 --port 8000
# then:
curl localhost:8000/health
IMG=$(base64 -w0 ../backend/uploads/catalogue/1.jpg)
curl -s -X POST localhost:8000/embed -H 'content-type: application/json' \
  -d "{\"image_b64\":\"$IMG\",\"mime\":\"image/jpeg\"}" | head -c 300
```

## Self-check

```bash
python app/preprocessing.py     # geometry + hashing, no network
python test_service.py          # + real inference if weights are reachable (skips gracefully otherwise)
```

## Deploy (Railway, CPU)

`Dockerfile` builds a CPU-only image (CPU torch wheel, no CUDA). `railway.json`
points the healthcheck at `/health`. Attach a **volume mounted at `MODEL_CACHE_DIR`**
so weights download once, not every cold start (or uncomment the bake-weights line
in the Dockerfile to embed them in the image). Single worker — the models are
RAM-bound; scale with replicas, not workers.
