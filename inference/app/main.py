"""FastAPI inference microservice for jewelry image embeddings (DINO + SigLIP 2).

Called by the Node/NestJS backend over HTTP. Fixed contract — see README.
"""
from __future__ import annotations

import base64
import binascii
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from .detection import JewelryDetector
from .preprocessing import PREPROCESSING_VERSION, BadImageError, decode_image, image_hash, letterbox
from .providers import DinoV3EmbeddingProvider, EmbeddingProvider, SigLIP2EmbeddingProvider

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
log = logging.getLogger("inference.main")

# --- config (env) ---
DINO_MODEL_ID = os.getenv("DINO_MODEL_ID", "facebook/dinov2-base")
SIGLIP_MODEL_ID = os.getenv("SIGLIP_MODEL_ID", "google/siglip2-base-patch16-224")
MODEL_CACHE_DIR = os.getenv("MODEL_CACHE_DIR") or os.getenv("HF_HOME")
HF_TOKEN = os.getenv("HF_TOKEN")
PREPROCESS_SIZE = int(os.getenv("PREPROCESS_SIZE", "224"))
API_KEY = os.getenv("INFERENCE_API_KEY")  # optional bearer; enforced only if set
MAX_BATCH = int(os.getenv("MAX_BATCH", "64"))
DETECTOR_MODEL_ID = os.getenv("DETECTOR_MODEL_ID", "IDEA-Research/grounding-dino-tiny")
# Views per image beyond the whole picture. A CAD sheet carries 4-6 renders; the
# ones past the fourth are near-repeats (a second profile, the back) and each
# costs an embedding and an index row.
MAX_VIEWS = int(os.getenv("MAX_VIEWS", "4"))

# --- metrics (plain counters; scrape at /metrics) ---
METRICS = {"embed_count": 0, "embed_failure": 0, "latency_ms_sum": 0.0}

providers: dict[str, EmbeddingProvider] = {}
detector = JewelryDetector(DETECTOR_MODEL_ID, MODEL_CACHE_DIR, HF_TOKEN)


def served_version() -> int:
    """The pipeline actually running. Without the detector no views are produced,
    which is exactly pipeline v1 — reporting 1 then keeps the backend from
    marking view-less vectors as current, so they are redone once it loads."""
    return PREPROCESSING_VERSION if detector.loaded else 1


@asynccontextmanager
async def lifespan(_: FastAPI):
    providers["dino"] = DinoV3EmbeddingProvider(DINO_MODEL_ID, MODEL_CACHE_DIR, HF_TOKEN)
    providers["siglip"] = SigLIP2EmbeddingProvider(SIGLIP_MODEL_ID, MODEL_CACHE_DIR, HF_TOKEN)
    for p in providers.values():
        try:
            p.load()
        except Exception:  # keep the service up; /health reports the dead model
            log.exception("failed to load model: %s", p.model_id)
    try:
        detector.load()
    except Exception:  # views are an improvement, not a dependency
        log.exception("failed to load detector: %s", DETECTOR_MODEL_ID)
    yield


app = FastAPI(title="Eclat jewelry embedding service", lifespan=lifespan)


# --- auth ---
def require_key(authorization: str | None = Header(default=None)) -> None:
    if not API_KEY:
        return
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="invalid or missing API key")


# --- schemas ---
class EmbedRequest(BaseModel):
    image_b64: str
    mime: str | None = None


class BatchItem(BaseModel):
    id: str
    image_b64: str
    mime: str | None = None


class BatchRequest(BaseModel):
    images: list[BatchItem]


def _decode(image_b64: str):
    """base64 -> (full-resolution image, normalized canvas, hash). Raises BadImageError."""
    try:
        raw = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BadImageError(f"invalid base64: {exc}") from exc
    full = decode_image(raw)
    canvas = letterbox(full, PREPROCESS_SIZE)
    return full, canvas, image_hash(canvas)


def _views(full) -> list[tuple[list[float], float, object]]:
    """Detected jewellery in `full`: (normalized box, score, canvas) per view."""
    w, h = full.size
    return [
        ([round(b[0] / w, 4), round(b[1] / h, 4), round(b[2] / w, 4), round(b[3] / h, 4)],
         round(b[4], 3), letterbox(crop, PREPROCESS_SIZE))
        for b, crop in detector.views(full, MAX_VIEWS)
    ]


def _view_json(views, dinos, siglips) -> list[dict]:
    return [
        {"box": box, "score": score, "dino": d.tolist(), "siglip": s.tolist()}
        for (box, score, _), d, s in zip(views, dinos, siglips)
    ]


def _both_loaded() -> None:
    for p in providers.values():
        if not p.loaded:
            raise HTTPException(status_code=500, detail=f"model not loaded: {p.model_id}")


@app.get("/health")
def health():
    return {
        "status": "ok" if all(p.loaded for p in providers.values()) else "degraded",
        "models": {
            p.name: {"id": p.model_id, "loaded": p.loaded, "dim": p.dim}
            for p in providers.values()
        },
        "detector": {"id": detector.model_id, "loaded": detector.loaded, "max_views": MAX_VIEWS},
        "preprocessing_version": served_version(),
    }


@app.get("/metrics")
def metrics():
    n = max(METRICS["embed_count"], 1)
    return {**METRICS, "latency_ms_avg": round(METRICS["latency_ms_sum"] / n, 2)}


@app.post("/embed")
def embed(req: EmbedRequest, _=Depends(require_key)):
    _both_loaded()
    t0 = time.perf_counter()
    try:
        full, img, h = _decode(req.image_b64)
    except BadImageError as exc:
        METRICS["embed_failure"] += 1
        raise HTTPException(status_code=400, detail=str(exc))
    views = _views(full)
    try:
        # Whole picture first, then each view, in one forward pass per model.
        canvases = [img] + [c for _, _, c in views]
        dinos = providers["dino"].embed_batch(canvases)
        siglips = providers["siglip"].embed_batch(canvases)
        dino, siglip = dinos[0], siglips[0]
    except Exception as exc:
        METRICS["embed_failure"] += 1
        log.exception("embedding failed")
        raise HTTPException(status_code=500, detail=f"embedding failed: {exc}")
    dt = (time.perf_counter() - t0) * 1000
    METRICS["embed_count"] += 1
    METRICS["latency_ms_sum"] += dt
    log.info("embed ok hash=%s views=%d ms=%.0f", h[:12], len(views), dt)
    return {
        "dino": dino.tolist(),
        "siglip": siglip.tolist(),
        "dino_dim": int(dino.shape[0]),
        "siglip_dim": int(siglip.shape[0]),
        "model_versions": {"dino": providers["dino"].model_id, "siglip": providers["siglip"].model_id},
        "preprocessing_version": served_version(),
        "image_hash": h,
        "views": _view_json(views, dinos[1:], siglips[1:]),
    }


@app.post("/embed/batch")
def embed_batch(req: BatchRequest, _=Depends(require_key)):
    _both_loaded()
    if len(req.images) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"batch too large (max {MAX_BATCH})")
    results, errors = [], []
    valid, imgs = [], []
    for item in req.images:
        try:
            full, img, h = _decode(item.image_b64)
            views = _views(full)
            valid.append((item.id, h, views)); imgs.append(img); imgs.extend(c for _, _, c in views)
        except BadImageError as exc:
            METRICS["embed_failure"] += 1
            errors.append({"id": item.id, "error": str(exc)})
    if imgs:
        try:
            dinos = providers["dino"].embed_batch(imgs)
            siglips = providers["siglip"].embed_batch(imgs)
        except Exception as exc:
            log.exception("batch embedding failed")
            raise HTTPException(status_code=500, detail=f"embedding failed: {exc}")
        # imgs is flat: each item's whole canvas followed by its views.
        at = 0
        for id_, h, views in valid:
            n = 1 + len(views)
            d, s = dinos[at:at + n], siglips[at:at + n]
            at += n
            METRICS["embed_count"] += 1
            results.append({"id": id_, "dino": d[0].tolist(), "siglip": s[0].tolist(), "image_hash": h,
                            "views": _view_json(views, d[1:], s[1:])})
    return {"results": results, "errors": errors}
