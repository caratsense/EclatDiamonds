"""Deterministic image preprocessing shared by every embedding provider.

ONE pipeline, versioned. Bump PREPROCESSING_VERSION whenever the geometry or
colour handling below changes so downstream vectors can be re-indexed knowingly.

Design notes (tuned to the Gati catalogue at backend/uploads/catalogue/):
  The catalogue mixes wide CAD spec-sheets (multiple views + dimension text on a
  white ground) with portrait phone photos of real pieces on paper/grey. Content
  spans the whole frame and aspect ratios are all over the place, so we LETTERBOX
  (aspect-preserving resize + centre-pad to a square) rather than centre-crop —
  a crop would slice off half the views. Padding is white because the dominant
  background already is; a white pad adds no edge the models would fixate on.
  No segmentation model: backgrounds are light and uniform enough that it would
  be cost with no measurable gain. Revisit only if busy/coloured backdrops show up.
"""
from __future__ import annotations

import hashlib
import io

from PIL import Image, ImageOps, ImageFile

PREPROCESSING_VERSION = 1

# Padding colour for the letterbox (neutral white, matches the catalogue ground).
PAD_COLOR = (255, 255, 255)
# Downscale anything whose longest side exceeds this before further work (cap cost).
MAX_SIDE = 4096
# Hard ceiling on decoded pixels — reject decompression bombs as a bad image (400).
MAX_PIXELS = 50_000_000
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP", "MPO"}  # MPO = multi-frame JPEG from phones

# Refuse to silently load truncated files; we want corrupt images to raise -> 400.
ImageFile.LOAD_TRUNCATED_IMAGES = False


class BadImageError(ValueError):
    """Raised for corrupt / unsupported / unreadable images -> HTTP 400."""


def normalize_image(raw: bytes, size: int = 224) -> Image.Image:
    """Decode -> orient -> flatten -> cap -> letterbox to a `size`x`size` RGB canvas.

    Deterministic and side-effect free (never touches the source file). Raises
    BadImageError on anything it cannot faithfully turn into a product image.
    """
    if not raw:
        raise BadImageError("empty image payload")
    try:
        img = Image.open(io.BytesIO(raw))
        fmt = img.format
        if fmt not in ALLOWED_FORMATS:
            raise BadImageError(f"unsupported image format: {fmt}")
        if img.width * img.height > MAX_PIXELS:
            raise BadImageError("image exceeds maximum allowed resolution")
        # Honour EXIF orientation, then force a full decode so corruption surfaces now.
        img = ImageOps.exif_transpose(img)
        img.load()
    except BadImageError:
        raise
    except Exception as exc:  # PIL raises a zoo of errors on bad data
        raise BadImageError(f"corrupt or unreadable image: {exc}") from exc

    # Flatten transparency / palette onto a white ground.
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, PAD_COLOR)
        canvas.paste(rgba, mask=rgba.split()[-1])
        img = canvas
    else:
        img = img.convert("RGB")

    # Cap oversized inputs before the (cheap) final resize.
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.BICUBIC)

    # Aspect-preserving resize + centre-pad to the square model canvas.
    return ImageOps.pad(img, (size, size), method=Image.BICUBIC,
                        color=PAD_COLOR, centering=(0.5, 0.5))


def image_hash(normalized: Image.Image) -> str:
    """SHA-256 over the normalized canvas — stable, model-independent dedup key."""
    h = hashlib.sha256()
    h.update(f"{PREPROCESSING_VERSION}:{normalized.mode}:{normalized.size}".encode())
    h.update(normalized.tobytes())
    return h.hexdigest()


if __name__ == "__main__":
    # Self-check: no network, no models — just the geometry + hashing contract.
    red = Image.new("RGB", (800, 200), (200, 0, 0))
    buf = io.BytesIO(); red.save(buf, format="PNG")
    a = normalize_image(buf.getvalue(), size=224)
    assert a.size == (224, 224) and a.mode == "RGB", a.size
    assert image_hash(a) == image_hash(normalize_image(buf.getvalue(), 224)), "hash not deterministic"

    # Transparent PNG must flatten to white, not black.
    tp = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    buf = io.BytesIO(); tp.save(buf, format="PNG")
    flat = normalize_image(buf.getvalue(), 224)
    assert flat.getpixel((0, 0)) == PAD_COLOR, flat.getpixel((0, 0))

    # A wide and a tall image of the same colour differ (padding position differs).
    wide = Image.new("RGB", (400, 100), (0, 128, 0)); tall = Image.new("RGB", (100, 400), (0, 128, 0))
    bw = io.BytesIO(); wide.save(bw, format="PNG"); bt = io.BytesIO(); tall.save(bt, format="PNG")
    assert image_hash(normalize_image(bw.getvalue(), 224)) != image_hash(normalize_image(bt.getvalue(), 224))

    # Corrupt bytes -> BadImageError.
    try:
        normalize_image(b"not an image", 224); assert False, "expected BadImageError"
    except BadImageError:
        pass
    print("preprocessing self-check OK")
