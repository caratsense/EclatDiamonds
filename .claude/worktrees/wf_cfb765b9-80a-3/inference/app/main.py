"""FastAPI inference microservice for jewelry image embeddings (DINO + SigLIP 2).

Called by the Node/NestJS backend over HTTP. Fixed contract — see README.
"""
from __future__ import annotations

import base64
import binascii
import hmac
import io
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .detection import JewelryDetector, needs_detection
from .preprocessing import (PREPROCESSING_VERSION, BadImageError, ImageTooLargeError, decode_image,
                            image_hash, letterbox)
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
API_KEY = os.getenv("INFERENCE_API_KEY") or ""  # enforced only if set; never logged
MAX_BATCH = int(os.getenv("MAX_BATCH", "16"))  # the backend sends 4 (index) or 3 (a search)
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(12 * 1024 * 1024)))  # largest catalogue photo is ~6.7MB
MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", str(64 * 1024 * 1024)))  # 4 x 12MB, base64'd, fits
DETECTOR_MODEL_ID = os.getenv("DETECTOR_MODEL_ID", "IDEA-Research/grounding-dino-tiny")
# Views per image beyond the whole picture. A CAD sheet carries 4-6 renders; the
# ones past the fourth are near-repeats (a second profile, the back) and each
# costs an embedding and an index row.
MAX_VIEWS = int(os.getenv("MAX_VIEWS", "4"))
# always: every image is run through the detector. auto: only when a cheap
# pixel heuristic says the piece is small in frame or the ground is busy (see
# detection.needs_detection and BENCHMARK.md). off: whole image only.
DETECT_MODE = os.getenv("DETECT_MODE", "always").lower()
if DETECT_MODE not in ("always", "auto", "off"):
    raise RuntimeError(f"DETECT_MODE must be always|auto|off, got {DETECT_MODE!r}")

# --- metrics (plain counters; scrape at /metrics) ---
METRICS = {"embed_count": 0, "embed_failure": 0, "latency_ms_sum": 0.0}

providers: dict[str, EmbeddingProvider] = {}
detector = JewelryDetector(DETECTOR_MODEL_ID, MODEL_CACHE_DIR, HF_TOKEN)


def served_version() -> int:
    """The pipeline actually running. Without the detector no views are produced,
    which is exactly pipeline v1 — reporting 1 then keeps the backend from
    marking view-less vectors as current, so they are redone once it loads."""
    return PREPROCESSING_VERSION if detector.loaded and DETECT_MODE != "off" and MAX_VIEWS > 0 else 1


@asynccontextmanager
async def lifespan(_: FastAPI):
    providers["dino"] = DinoV3EmbeddingProvider(DINO_MODEL_ID, MODEL_CACHE_DIR, HF_TOKEN)
    providers["siglip"] = SigLIP2EmbeddingProvider(SIGLIP_MODEL_ID, MODEL_CACHE_DIR, HF_TOKEN)
    for p in providers.values():
        try:
            p.load()
        except Exception:  # keep the service up; /health reports the dead model
            log.exception("failed to load model: %s", p.model_id)
    if DETECT_MODE != "off":
        try:
            detector.load()
        except Exception:  # views are an improvement, not a dependency
            log.exception("failed to load detector: %s", DETECTOR_MODEL_ID)
    yield


app = FastAPI(title="Eclat jewelry embedding service", lifespan=lifespan)


# --- auth + body size, before a single body byte is read ---
def _key_ok(request: Request) -> bool:
    """x-api-key, or the older `Authorization: Bearer` the backend still sends.
    Both compared in constant time."""
    want = API_KEY.encode()
    got = request.headers.get("x-api-key")
    if got is not None and hmac.compare_digest(got.encode(), want):
        return True
    auth = request.headers.get("authorization") or ""
    return auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].encode(), want)


@app.middleware("http")
async def guard(request: Request, call_next):
    if request.url.path != "/health":
        if API_KEY and not _key_ok(request):
            return JSONResponse({"detail": "invalid or missing API key"}, status_code=401)
        if request.method in ("POST", "PUT", "PATCH"):
            # uvicorn holds a body to its Content-Length, so checking the header
            # bounds what is read; a chunked body has none and is refused.
            cl = request.headers.get("content-length")
            if cl is None or not cl.isdigit():
                return JSONResponse({"detail": "Content-Length required"}, status_code=411)
            if int(cl) > MAX_BODY_BYTES:
                return JSONResponse({"detail": f"request body over {MAX_BODY_BYTES} bytes"}, status_code=413)
    return await call_next(request)


# --- schemas ---
class EmbedRequest(BaseModel):
    image_b64: str
    mime: str | None = None  # informational; the bytes are sniffed


class BatchItem(BaseModel):
    id: str = Field(max_length=200)
    image_b64: str
    mime: str | None = None


class BatchRequest(BaseModel):
    images: list[BatchItem]
    # When set, each result also carries a JPEG thumbnail (long side <= this) cut
    # from the decoded, EXIF-oriented, flattened image, and the decoded size.
    thumbnail_px: int | None = Field(default=None, ge=16, le=2048)


class Timer:
    """Per-stage wall time in ms, summed across a request's images."""

    def __init__(self):
        self.t0 = time.perf_counter()
        self.ms = {"decode": 0.0, "detect": 0.0, "dino": 0.0, "siglip": 0.0}

    def run(self, stage: str, fn, *args):
        t = time.perf_counter()
        try:
            return fn(*args)
        finally:
            self.ms[stage] += (time.perf_counter() - t) * 1000

    def done(self, response: Response) -> dict:
        out = {k: round(v, 1) for k, v in self.ms.items()}
        out["total"] = round((time.perf_counter() - self.t0) * 1000, 1)
        response.headers["Server-Timing"] = ", ".join(f"{k};dur={v}" for k, v in out.items())
        return out


def _decode(image_b64: str):
    """base64 -> (full-resolution image, normalized canvas, hash). Raises BadImageError."""
    # base64 is 4/3 of the bytes: refuse an oversized image before decoding it.
    if len(image_b64) > (MAX_IMAGE_BYTES + 2) // 3 * 4:
        raise ImageTooLargeError(f"image over {MAX_IMAGE_BYTES} bytes")
    try:
        raw = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BadImageError(f"invalid base64: {exc}") from exc
    full = decode_image(raw)
    canvas = letterbox(full, PREPROCESS_SIZE)
    return full, canvas, image_hash(canvas)


def _views(full) -> list[tuple[list[float], float, object]]:
    """Detected jewellery in `full`: (normalized box, score, canvas) per view."""
    if DETECT_MODE == "off" or (DETECT_MODE == "auto" and not needs_detection(full)):
        return []
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


def _thumb(full, px: int) -> dict:
    """`full` is already oriented and RGB; width/height are its decoded size
    (after the MAX_SIDE cap in preprocessing, which only bites past 4096px)."""
    t = full.copy()
    t.thumbnail((px, px))
    buf = io.BytesIO()
    t.save(buf, "JPEG", quality=85)
    return {"thumb_b64": base64.b64encode(buf.getvalue()).decode(), "thumb_mime": "image/jpeg",
            "width": full.width, "height": full.height}


def _both_loaded() -> None:
    for p in providers.values():
        if not p.loaded:
            raise HTTPException(status_code=503, detail=f"model not loaded: {p.model_id}")
    if not providers:
        raise HTTPException(status_code=503, detail="models not loaded")


def _model_versions() -> dict:
    return {"dino": DINO_MODEL_ID, "siglip": SIGLIP_MODEL_ID}


@app.get("/health")
def health():
    return {
        "status": "ok" if providers and all(p.loaded for p in providers.values()) else "degraded",
        # The shape the backend reads (ml-inference.service.ts currentVersions).
        "model_versions": _model_versions(),
        "models": {
            p.name: {"id": p.model_id, "loaded": p.loaded, "dim": p.dim}
            for p in providers.values()
        },
        "detector": {"id": detector.model_id, "loaded": detector.loaded, "max_views": MAX_VIEWS,
                     "mode": DETECT_MODE},
        "preprocessing_version": served_version(),
        "auth_required": bool(API_KEY),
        "limits": {"max_batch": MAX_BATCH, "max_image_bytes": MAX_IMAGE_BYTES, "max_body_bytes": MAX_BODY_BYTES},
    }


@app.get("/metrics")
def metrics():
    n = max(METRICS["embed_count"], 1)
    return {**METRICS, "latency_ms_avg": round(METRICS["latency_ms_sum"] / n, 2)}


def _embed_all(timer: Timer, canvases):
    try:
        dinos = timer.run("dino", providers["dino"].embed_batch, canvases)
        siglips = timer.run("siglip", providers["siglip"].embed_batch, canvases)
    except Exception as exc:
        METRICS["embed_failure"] += 1
        log.exception("embedding failed")
        raise HTTPException(status_code=500, detail=f"embedding failed: {exc}")
    return dinos, siglips


@app.post("/embed")
def embed(req: EmbedRequest, response: Response):
    timer = Timer()
    try:
        full, img, h = timer.run("decode", _decode, req.image_b64)
    except BadImageError as exc:
        METRICS["embed_failure"] += 1
        raise HTTPException(status_code=exc.status, detail=str(exc))
    _both_loaded()
    views = timer.run("detect", _views, full)
    # Whole picture first, then each view, in one forward pass per model.
    dinos, siglips = _embed_all(timer, [img] + [c for _, _, c in views])
    dino, siglip = dinos[0], siglips[0]
    timings = timer.done(response)
    METRICS["embed_count"] += 1
    METRICS["latency_ms_sum"] += timings["total"]
    log.info("embed ok hash=%s views=%d ms=%.0f", h[:12], len(views), timings["total"])
    return {
        "dino": dino.tolist(),
        "siglip": siglip.tolist(),
        "dino_dim": int(dino.shape[0]),
        "siglip_dim": int(siglip.shape[0]),
        "model_versions": _model_versions(),
        "preprocessing_version": served_version(),
        "image_hash": h,
        "views": _view_json(views, dinos[1:], siglips[1:]),
        "timings_ms": timings,
    }


@app.post("/embed/batch")
def embed_batch(req: BatchRequest, response: Response):
    if len(req.images) > MAX_BATCH:
        raise HTTPException(status_code=413, detail=f"batch too large (max {MAX_BATCH} images)")
    timer = Timer()
    results, errors = [], []
    decoded = []
    for item in req.images:
        try:
            decoded.append((item.id, *timer.run("decode", _decode, item.image_b64)))
        except BadImageError as exc:
            METRICS["embed_failure"] += 1
            errors.append({"id": item.id, "error": str(exc), "status": exc.status})
    if decoded:
        _both_loaded()
    valid, imgs = [], []
    for id_, full, img, h in decoded:
        views = timer.run("detect", _views, full)
        extra = _thumb(full, req.thumbnail_px) if req.thumbnail_px else {}
        valid.append((id_, h, views, extra)); imgs.append(img); imgs.extend(c for _, _, c in views)
    if imgs:
        dinos, siglips = _embed_all(timer, imgs)
        # imgs is flat: each item's whole canvas followed by its views.
        at = 0
        for id_, h, views, extra in valid:
            n = 1 + len(views)
            d, s = dinos[at:at + n], siglips[at:at + n]
            at += n
            METRICS["embed_count"] += 1
            results.append({"id": id_, "dino": d[0].tolist(), "siglip": s[0].tolist(), "image_hash": h,
                            "views": _view_json(views, d[1:], s[1:]), **extra})
    timings = timer.done(response)
    METRICS["latency_ms_sum"] += timings["total"]
    return {"results": results, "errors": errors, "model_versions": _model_versions(),
            "preprocessing_version": served_version(), "timings_ms": timings}
