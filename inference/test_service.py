"""Self-check for the embedding service.

Two layers:
  1. ALWAYS runs (no network, no models): preprocessing geometry/hashing, MIME
     sniffing, the decompression-bomb guard, and the HTTP guard (API key, body /
     image / batch limits, 4xx codes) through FastAPI's TestClient.
  2. BEST-EFFORT: if the models can be loaded, embed a solid colour and a real
     catalogue image and assert response shape + that different images -> different
     vectors. Skips gracefully (not a failure) if weights can't be fetched here.

Run:  python test_service.py      (or: python -m pytest test_service.py)
"""
import base64
import io
import os
import sys
import warnings

# Limits small enough to trip in a test; set before app.main reads them.
os.environ.update(INFERENCE_API_KEY="test-key", MAX_IMAGE_BYTES="200000",
                  MAX_BODY_BYTES="1000000", MAX_BATCH="3")

from PIL import Image  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
from app.preprocessing import (PREPROCESSING_VERSION, ImageTooLargeError, UnsupportedImageError,  # noqa: E402
                               decode_image, image_hash, normalize_image, sniff_mime)

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = {"x-api-key": "test-key"}


def _bytes(img: Image.Image, fmt="JPEG") -> bytes:
    buf = io.BytesIO(); img.save(buf, format=fmt)
    return buf.getvalue()


def _b64(img: Image.Image, fmt="JPEG") -> str:
    return base64.b64encode(_bytes(img, fmt)).decode()


def test_preprocessing():
    solid = Image.new("RGB", (640, 480), (10, 20, 200))
    norm = normalize_image(base64.b64decode(_b64(solid)), 224)
    assert norm.size == (224, 224) and norm.mode == "RGB"
    assert PREPROCESSING_VERSION == 2  # v2: detected-jewellery views
    # deterministic hash
    assert image_hash(norm) == image_hash(normalize_image(base64.b64decode(_b64(solid)), 224))
    print("[ok] preprocessing shape + deterministic hash")


def test_mime_sniffing():
    img = Image.new("RGB", (32, 32), (1, 2, 3))
    assert sniff_mime(_bytes(img, "JPEG")) == "image/jpeg"
    assert sniff_mime(_bytes(img, "PNG")) == "image/png"
    assert sniff_mime(_bytes(img, "WEBP")) == "image/webp"
    for fmt in ("GIF", "BMP", "TIFF"):  # real images, just not ones we take
        data = _bytes(img, fmt)
        assert sniff_mime(data) is None, fmt
        try:
            decode_image(data); assert False, fmt
        except UnsupportedImageError:
            pass
    print("[ok] MIME sniffing: jpeg/png/webp only")


def test_decompression_bomb():
    # 8000x8000 (64MP) is over our 50MP ceiling but under PIL's own 2x error: the
    # explicit check refuses it. 11000x11000 (121MP) trips PIL's guard at open.
    for side in (8000, 11000):
        data = _bytes(Image.new("1", (side, side)), "PNG")
        assert len(data) < 200_000, "the point: tiny file, huge image"
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            try:
                decode_image(data); assert False, side
            except ImageTooLargeError:
                pass
    print("[ok] decompression bomb refused before decode")


def test_http_guard():
    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)  # no `with`: lifespan (model load) never runs
    small = {"image_b64": _b64(Image.new("RGB", (64, 64), (9, 9, 9)))}

    # health is open and tells nothing secret
    h = c.get("/health")
    assert h.status_code == 200 and "test-key" not in h.text and h.json()["auth_required"] is True
    assert set(h.json()["model_versions"]) == {"dino", "siglip"}

    # key: missing / wrong -> 401, on every route but /health
    for path in ("/embed", "/embed/batch"):
        assert c.post(path, json=small).status_code == 401
        assert c.post(path, json=small, headers={"x-api-key": "nope"}).status_code == 401
    assert c.get("/metrics").status_code == 401
    assert c.get("/metrics", headers=KEY).status_code == 200
    assert c.get("/metrics", headers={"authorization": "Bearer test-key"}).status_code == 200  # legacy header

    # a good image with the right key gets past every guard, to the models
    # (not loaded here -> 503, which is exactly "past the guard")
    assert c.post("/embed", json=small, headers=KEY).status_code == 503

    # body over MAX_BODY_BYTES -> 413 before it is parsed
    r = c.post("/embed", content=b"{" + b" " * 1_000_001 + b"}", headers={**KEY, "content-type": "application/json"})
    assert r.status_code == 413, r.status_code

    # one image over MAX_IMAGE_BYTES -> 413 (noise does not compress)
    import numpy as np
    noise = Image.fromarray(np.random.default_rng(0).integers(0, 255, (400, 400, 3), dtype=np.uint8))
    big = _b64(noise, "PNG")
    assert 200_000 < len(big) * 3 // 4 < 1_000_000
    r = c.post("/embed", json={"image_b64": big}, headers=KEY)
    assert r.status_code == 413 and "bytes" in r.json()["detail"], r.text

    # not an image type we take -> 415; not base64 / not an image -> 400
    gif = _b64(Image.new("RGB", (8, 8)), "GIF")
    assert c.post("/embed", json={"image_b64": gif, "mime": "image/jpeg"}, headers=KEY).status_code == 415
    assert c.post("/embed", json={"image_b64": "@@@"}, headers=KEY).status_code == 400
    trunc = base64.b64encode(base64.b64decode(small["image_b64"])[:40]).decode()
    assert c.post("/embed", json={"image_b64": trunc}, headers=KEY).status_code == 400

    # bomb through the API -> 413
    bomb = _b64(Image.new("1", (8000, 8000)), "PNG")
    assert c.post("/embed", json={"image_b64": bomb}, headers=KEY).status_code == 413

    # batch: too many -> 413; bad items are per-item errors with their code
    four = {"images": [{"id": str(i), **small} for i in range(4)]}
    assert c.post("/embed/batch", json=four, headers=KEY).status_code == 413
    r = c.post("/embed/batch", json={"images": [{"id": "g", "image_b64": gif}, {"id": "b", "image_b64": bomb}]},
               headers=KEY)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [(e["id"], e["status"]) for e in body["errors"]] == [("g", 415), ("b", 413)] and body["results"] == []
    assert set(body["timings_ms"]) == {"decode", "detect", "dino", "siglip", "total"}
    assert "total;dur=" in r.headers["server-timing"]
    print("[ok] http guard: key, body/image/batch limits, 400/401/413/415")


def test_batch_thumbnails():
    import numpy as np
    from fastapi.testclient import TestClient
    from app import main

    class Fake:  # stands in for a loaded model: the path under test is the HTTP one
        loaded, model_id, dim = True, "fake", 4
        def embed_batch(self, imgs):
            return [np.ones(4, np.float32) / 2 for _ in imgs]

    main.providers.update(dino=Fake(), siglip=Fake())
    try:
        c = TestClient(main.app)
        # 300x100 JPEG tagged EXIF orientation 6 (rotate 90): decodes as 100x300.
        exif = Image.Exif(); exif[0x0112] = 6
        buf = io.BytesIO(); Image.new("RGB", (300, 100), (200, 30, 30)).save(buf, "JPEG", exif=exif)
        item = {"id": "a", "image_b64": base64.b64encode(buf.getvalue()).decode()}

        plain = c.post("/embed/batch", json={"images": [item]}, headers=KEY).json()["results"][0]
        assert not {"thumb_b64", "thumb_mime", "width", "height"} & set(plain), "unchanged without thumbnail_px"

        r = c.post("/embed/batch", json={"images": [item], "thumbnail_px": 64}, headers=KEY).json()["results"][0]
        assert (r["width"], r["height"]) == (100, 300) and r["thumb_mime"] == "image/jpeg"
        t = Image.open(io.BytesIO(base64.b64decode(r["thumb_b64"])))
        assert t.format == "JPEG" and t.mode == "RGB" and max(t.size) == 64 and t.height > t.width, t.size
        assert c.post("/embed/batch", json={"images": [item], "thumbnail_px": 5}, headers=KEY).status_code == 422
    finally:
        main.providers.clear()
    print("[ok] batch thumbnails: only when asked, oriented, <= thumbnail_px")


def _catalogue_sample():
    d = os.path.join(HERE, "..", "backend", "uploads", "catalogue")
    for name in ("1.jpg", "101.jpg", "500.jpg"):
        p = os.path.join(d, name)
        if os.path.exists(p):
            with open(p, "rb") as f:
                return f.read()
    return None


def test_inference_best_effort():
    try:
        from app.providers import DinoV3EmbeddingProvider, SigLIP2EmbeddingProvider
        dino = DinoV3EmbeddingProvider(os.getenv("DINO_MODEL_ID", "facebook/dinov2-base"),
                                       os.getenv("MODEL_CACHE_DIR"), os.getenv("HF_TOKEN"))
        siglip = SigLIP2EmbeddingProvider(os.getenv("SIGLIP_MODEL_ID", "google/siglip2-base-patch16-224"),
                                          os.getenv("MODEL_CACHE_DIR"), os.getenv("HF_TOKEN"))
        dino.load(); siglip.load()
    except Exception as exc:
        print(f"[skip] model load unavailable here ({type(exc).__name__}: {exc})")
        return

    red = normalize_image(base64.b64decode(_b64(Image.new("RGB", (300, 300), (220, 10, 10)))), 224)
    real_bytes = _catalogue_sample()
    other = (normalize_image(real_bytes, 224) if real_bytes
             else normalize_image(base64.b64decode(_b64(Image.new("RGB", (300, 300), (10, 10, 220)))), 224))

    for prov in (dino, siglip):
        va, vb = prov.embed(red), prov.embed(other)
        assert va.shape == vb.shape == (prov.dim,), (prov.name, va.shape, prov.dim)
        import numpy as np
        assert abs(float(np.linalg.norm(va)) - 1.0) < 1e-4, f"{prov.name} not L2-normalized"
        assert float(np.dot(va, vb)) < 0.999, f"{prov.name}: distinct images gave ~identical vectors"
        print(f"[ok] {prov.name}: dim={prov.dim}, L2-normalized, distinct images differ")

    print("[ok] real inference verified")


if __name__ == "__main__":
    test_preprocessing()
    test_mime_sniffing()
    test_decompression_bomb()
    test_http_guard()
    test_batch_thumbnails()
    test_inference_best_effort()
    print("DONE")
