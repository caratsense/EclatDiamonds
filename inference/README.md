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

## Preprocessing (ONE deterministic pipeline, `preprocessing_version = 2`)

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
adds no edge the models fixate on.

## Detected views (v2, `app/detection.py`)

Busy backdrops did appear. A shop photo of a pendant on a green velvet stand is
~15% pendant, so its whole-frame vector is mostly velvet; a Gati CAD sheet is five
small renders plus dimension callouts, so its vector is mostly "technical drawing".
The two never matched each other, even for the same piece.

So every image also goes through an open-vocabulary detector — **Grounding DINO
tiny** (`IDEA-Research/grounding-dino-tiny`, Apache-2.0, ~660MB), prompted with
jewellery words. Each piece it boxes (the pendant on the stand, every render on a
sheet, the ring on a hand) is cropped with a little margin, letterboxed like any
image, and embedded as a **view** alongside the whole frame. Boxes that are the whole
picture, specks, near-duplicates and "group" boxes wrapping two or more pieces are
dropped (`select_views`, self-checked by `python -m app.detection`). The backend
stores each view as its own index row and scores a design on its best view against
the query's best view.

Chosen over background removal (rembg/BiRefNet), which keeps the velvet stand as
"the object", and over OWLv2, which was several times slower on CPU. If the detector
fails to load, the service still answers whole-image only and reports
`preprocessing_version: 1`, so nothing view-less is recorded as current.

`image_hash` is a SHA-256 over the *normalized* canvas — a stable, model-independent
dedup / change-detection key. Bump `PREPROCESSING_VERSION` if the pipeline changes.

## HTTP contract

`POST /embed` — `{"image_b64": "<base64>", "mime": "image/jpeg"}` →
```json
{ "dino": [..768..], "siglip": [..768..], "dino_dim": 768, "siglip_dim": 768,
  "model_versions": {"dino": "facebook/dinov2-base", "siglip": "google/siglip2-base-patch16-224"},
  "preprocessing_version": 2, "image_hash": "<sha256>",
  "views": [{"box": [x0, y0, x1, y1], "score": 0.61, "dino": [..768..], "siglip": [..768..]}] }
```
`box` is normalised to 0–1 of the image; `views` is best-first, at most `MAX_VIEWS`,
and empty when nothing was detected. Bad/corrupt/unsupported image → `400 {"error": "..."}`; model failure → `500 {"error": "..."}`.
(FastAPI wraps the message as `{"detail": "..."}`; the backend reads `detail`.)

`POST /embed/batch` — `{"images": [{"id","image_b64","mime"}, ...]}` →
`{"results": [{"id","dino","siglip","image_hash","views"}], "errors": [{"id","error"}]}`.
Per-image errors don't fail the batch. Batched through the model in one forward pass
(efficient for the ~2000-image one-time catalogue index). Cap `MAX_BATCH` (default 64).

`GET /health` → `{"status": "ok"|"degraded", "models": {"dino": {"id","loaded","dim"}, "siglip": {...}}, "detector": {"id","loaded","max_views"}, "preprocessing_version": 2}`.

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
| `DETECTOR_MODEL_ID` | `IDEA-Research/grounding-dino-tiny` | Jewellery detector for views. |
| `MAX_VIEWS` | `4` | Views per image beyond the whole frame (`0` turns views off). |
| `DETECT_BOX_THRESHOLD` / `DETECT_TEXT_THRESHOLD` | `0.25` / `0.2` | Detector confidence floors. |
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
