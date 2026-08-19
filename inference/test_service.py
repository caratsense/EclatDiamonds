"""Self-check for the embedding service.

Two layers:
  1. ALWAYS runs (no network): preprocessing geometry/hashing + service imports.
  2. BEST-EFFORT: if the models can be loaded, embed a solid colour and a real
     catalogue image and assert response shape + that different images -> different
     vectors. Skips gracefully (not a failure) if weights can't be fetched here.

Run:  python test_service.py
"""
import base64
import io
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from app.preprocessing import PREPROCESSING_VERSION, image_hash, normalize_image  # noqa: E402


def _b64(img: Image.Image, fmt="JPEG") -> str:
    buf = io.BytesIO(); img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode()


def test_preprocessing():
    solid = Image.new("RGB", (640, 480), (10, 20, 200))
    norm = normalize_image(base64.b64decode(_b64(solid)), 224)
    assert norm.size == (224, 224) and norm.mode == "RGB"
    assert PREPROCESSING_VERSION == 1
    # deterministic hash
    assert image_hash(norm) == image_hash(normalize_image(base64.b64decode(_b64(solid)), 224))
    print("[ok] preprocessing shape + deterministic hash")


def _catalogue_sample():
    d = r"C:\Users\Shrey\Eclat\backend\uploads\catalogue"
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
    test_inference_best_effort()
    print("DONE")
