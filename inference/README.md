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

**Auth.** When `INFERENCE_API_KEY` is set, every route except `/health` (including
`/metrics` and `/docs`) needs header `x-api-key: <key>` (constant-time compare;
the key is never logged). `Authorization: Bearer <key>` is still accepted for the
backend's current client; new callers should send `x-api-key`. Missing/wrong -> `401`.

**Limits (checked before the body is parsed where possible).** POST without
`Content-Length` -> `411`; body over `MAX_BODY_BYTES` -> `413`; one image over
`MAX_IMAGE_BYTES` -> `413`; more than `MAX_BATCH` images -> `413`; bytes that are not
JPEG/PNG/WebP by their magic number (the declared `mime` is ignored) -> `415`;
more than `MAX_IMAGE_PIXELS` pixels (decompression bomb; refused from the header,
and `PIL.Image.MAX_IMAGE_PIXELS` set to the same value as a second lock) -> `413`;
bad base64 / corrupt / truncated -> `400`; models not loaded -> `503`; model
failure -> `500`. Errors are `{"detail": "..."}` (the backend reads `detail`).

`POST /embed` — `{"image_b64": "<base64>", "mime": "image/jpeg"}` →
```json
{ "dino": [..768..], "siglip": [..768..], "dino_dim": 768, "siglip_dim": 768,
  "model_versions": {"dino": "facebook/dinov2-base", "siglip": "google/siglip2-base-patch16-224"},
  "preprocessing_version": 2, "image_hash": "<sha256>",
  "views": [{"box": [x0, y0, x1, y1], "score": 0.61, "dino": [..768..], "siglip": [..768..]}],
  "timings_ms": {"decode": 4.1, "detect": 8419.0, "dino": 846.2, "siglip": 706.0, "total": 11736.4} }
```
`box` is normalised to 0–1 of the image; `views` is best-first, at most `MAX_VIEWS`,
and empty when nothing was detected (or detection was skipped, see `DETECT_MODE`).

`POST /embed/batch` — `{"images": [{"id","image_b64","mime"}, ...]}` →
`{"results": [{"id","dino","siglip","image_hash","views"}], "errors": [{"id","error","status"}], "model_versions", "preprocessing_version", "timings_ms"}`.
Optional `"thumbnail_px": 16..2048` in the request: each result then also carries
`thumb_b64` (JPEG, long side <= `thumbnail_px`, cut from the EXIF-oriented,
white-flattened decode), `thumb_mime` (`image/jpeg`) and `width`/`height` (the decoded
size; images past 4096px are capped to that first). Without it the response is unchanged.
Per-image errors (with their would-be HTTP `status`) don't fail the batch. Batched
through each model in one forward pass. `timings_ms` sums each stage over the batch.

Both embed routes also send `Server-Timing: decode;dur=..., detect;dur=..., dino;dur=..., siglip;dur=..., total;dur=...`.

`GET /health` (open) → `{"status": "ok"|"degraded", "model_versions": {"dino","siglip"},
"models": {"dino": {"id","loaded","dim"}, "siglip": {...}}, "detector": {"id","loaded","max_views","mode"},
"preprocessing_version": 2, "auth_required": true, "limits": {"max_batch","max_image_bytes","max_body_bytes"}}`.
`model_versions` is what the backend's `currentVersions()` reads.

`GET /metrics` → `{"embed_count","embed_failure","latency_ms_sum","latency_ms_avg"}`.

## Detection mode

`DETECT_MODE=always` (default) runs the detector on every image. `auto` runs it only
when a sub-millisecond pixel heuristic (`detection.needs_detection`: border
texture, share of the frame that differs from the ground) says the piece is small
in frame or the background is busy; `off` never runs it and reports
`preprocessing_version: 1`. `auto` still reports `2`, so **build the index with
`always`** — an index built under `auto` lacks views for the images it skipped and
the backend would treat them as current. See `BENCHMARK.md` for why `always` stays
the default.

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8000` | Listen port (Railway injects this). |
| `MODEL_CACHE_DIR` / `HF_HOME` | HF default | Where weights are cached. |
| `INFERENCE_API_KEY` | *(unset)* | If set, every route but `/health` requires `x-api-key` (or legacy `Authorization: Bearer`). |
| `MAX_BODY_BYTES` | `67108864` (64 MiB) | Request body ceiling (`413`). |
| `MAX_IMAGE_BYTES` | `12582912` (12 MiB) | Per decoded image (`413`); the largest catalogue photo is ~6.7 MB. |
| `MAX_IMAGE_PIXELS` | `50000000` | Decompression-bomb ceiling (`413`). |
| `MAX_BATCH` | `16` | Max images per `/embed/batch` (`413`); the backend sends 4 when indexing. |
| `DETECT_MODE` | `always` | `always` / `auto` / `off` (see above). |
| `AUTO_MIN_FG_FRAC` / `AUTO_MAX_BORDER_STD` | `0.18` / `18` | `auto` heuristic knobs. |
| `DINO_MODEL_ID` | `facebook/dinov2-base` | Swap in DINOv3 (see above). |
| `SIGLIP_MODEL_ID` | `google/siglip2-base-patch16-224` | Override SigLIP variant. |
| `HF_TOKEN` | *(unset)* | Required only for gated models (DINOv3). |
| `PREPROCESS_SIZE` | `224` | Square canvas size. |
| `DETECTOR_MODEL_ID` | `IDEA-Research/grounding-dino-tiny` | Jewellery detector for views. |
| `MAX_VIEWS` | `4` | Views per image beyond the whole frame (`0` turns views off). |
| `DETECT_BOX_THRESHOLD` / `DETECT_TEXT_THRESHOLD` | `0.25` / `0.2` | Detector confidence floors. |
| `TORCH_NUM_THREADS` | `#cpus` | CPU thread cap. |
| `LOG_LEVEL` | `INFO` | Logging level. |

No raw image bytes, and never the API key, are logged — only hashes, dims, and latency.

## Run locally

```bash
cd inference
python -m venv .venv && . .venv/Scripts/activate   # Windows; use bin/activate on *nix
pip install -r requirements.txt
export MODEL_CACHE_DIR=./models          # first run downloads ~0.7 GB of weights
uvicorn app.main:app --host 0.0.0.0 --port 8000
# then:
curl localhost:8000/health
# with INFERENCE_API_KEY set, add: -H "x-api-key: $INFERENCE_API_KEY"
IMG=$(base64 -w0 ../backend/uploads/catalogue/1.jpg)
curl -s -X POST localhost:8000/embed -H 'content-type: application/json' \
  -d "{\"image_b64\":\"$IMG\",\"mime\":\"image/jpeg\"}" | head -c 300
```

## Self-check

```bash
python app/preprocessing.py     # geometry + hashing, no network
python -m app.detection         # view selection + auto heuristic, no network
python test_service.py          # + auth/limits/MIME/bomb via TestClient, + real inference if weights are reachable
```

## Benchmark

`python bench/bench.py latency` and `python bench/bench.py recall` — see
`bench/bench.py` docstring; results in `BENCHMARK.md`.

## Deploy (Railway, CPU)

`Dockerfile` builds a CPU-only image (CPU torch wheel, no CUDA). `railway.json`
points the healthcheck at `/health`. Attach a **volume mounted at `MODEL_CACHE_DIR`**
so weights download once, not every cold start (or uncomment the bake-weights line
in the Dockerfile to embed them in the image). Single worker — the models are
RAM-bound; scale with replicas, not workers.
