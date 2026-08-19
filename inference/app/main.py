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

from .preprocessing import PREPROCESSING_VERSION, BadImageError, image_hash, normalize_image
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

# --- metrics (plain counters; scrape at /metrics) ---
METRICS = {"embed_count": 0, "embed_failure": 0, "latency_ms_sum": 0.0}

providers: dict[str, EmbeddingProvider] = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    providers["dino"] = DinoV3EmbeddingProvider(DINO_MODEL_ID, MODEL_CACHE_DIR, HF_TOKEN)
    providers["siglip"] = SigLIP2EmbeddingProvider(SIGLIP_MODEL_ID, MODEL_CACHE_DIR, HF_TOKEN)
    for p in providers.values():
        try:
            p.load()
        except Exception:  # keep the service up; /health reports the dead model
            log.exception("failed to load model: %s", p.model_id)
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
    """base64 -> normalized PIL image (+ hash). Raises BadImageError on bad input."""
    try:
        raw = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BadImageError(f"invalid base64: {exc}") from exc
    img = normalize_image(raw, size=PREPROCESS_SIZE)
    return img, image_hash(img)


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
        "preprocessing_version": PREPROCESSING_VERSION,
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
        img, h = _decode(req.image_b64)
    except BadImageError as exc:
        METRICS["embed_failure"] += 1
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        dino = providers["dino"].embed(img)
        siglip = providers["siglip"].embed(img)
    except Exception as exc:
        METRICS["embed_failure"] += 1
        log.exception("embedding failed")
        raise HTTPException(status_code=500, detail=f"embedding failed: {exc}")
    dt = (time.perf_counter() - t0) * 1000
    METRICS["embed_count"] += 1
    METRICS["latency_ms_sum"] += dt
    log.info("embed ok hash=%s dino=%d siglip=%d ms=%.0f", h[:12], dino.shape[0], siglip.shape[0], dt)
    return {
        "dino": dino.tolist(),
        "siglip": siglip.tolist(),
        "dino_dim": int(dino.shape[0]),
        "siglip_dim": int(siglip.shape[0]),
        "model_versions": {"dino": providers["dino"].model_id, "siglip": providers["siglip"].model_id},
        "preprocessing_version": PREPROCESSING_VERSION,
        "image_hash": h,
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
            img, h = _decode(item.image_b64)
            valid.append((item.id, h)); imgs.append(img)
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
        for (id_, h), d, s in zip(valid, dinos, siglips):
            METRICS["embed_count"] += 1
            results.append({"id": id_, "dino": d.tolist(), "siglip": s.tolist(), "image_hash": h})
    return {"results": results, "errors": errors}
