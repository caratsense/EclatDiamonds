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
  Busy/coloured backdrops did show up (a pendant on a green velvet stand, a ring
  on a hand), and CAD sheets hold several views on one canvas — so since v2 the
  whole picture is no longer the only thing embedded: detection.py boxes each
  piece of jewellery and every box is embedded as a view of its own.
"""
from __future__ import annotations

import hashlib
import io
import os

from PIL import Image, ImageOps, ImageFile

# v2: every image also yields detected-jewellery views (detection.py). The
# whole-image vector is unchanged; the bump is what makes the backend re-index
# the catalogue so existing designs gain their views.
PREPROCESSING_VERSION = 2

# Padding colour for the letterbox (neutral white, matches the catalogue ground).
PAD_COLOR = (255, 255, 255)
# Downscale anything whose longest side exceeds this before further work (cap cost).
MAX_SIDE = 4096
# Hard ceiling on decoded pixels: a decompression bomb (a few KB of PNG that
# inflates to gigabytes) is refused from its header, before any pixel is decoded.
MAX_PIXELS = int(os.getenv("MAX_IMAGE_PIXELS", "50000000"))
# PIL's own guard, set to the same ceiling: it raises past 2x this, which the
# explicit check below never lets it reach; it is the second lock, not the first.
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP", "MPO"}  # MPO = multi-frame JPEG from phones

# Refuse to silently load truncated files; we want corrupt images to raise -> 400.
ImageFile.LOAD_TRUNCATED_IMAGES = False


class BadImageError(ValueError):
    """Raised for corrupt / unreadable images. `status` is the HTTP code."""
    status = 400


class UnsupportedImageError(BadImageError):
    """Bytes that are not JPEG, PNG or WebP, whatever the caller said they were."""
    status = 415


class ImageTooLargeError(BadImageError):
    """Too many bytes, or too many pixels (decompression bomb)."""
    status = 413


def sniff_mime(raw: bytes) -> str | None:
    """The type the bytes ARE, from their magic number. The declared mime is a
    file-extension guess on the caller's side and is never trusted."""
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def normalize_image(raw: bytes, size: int = 224) -> Image.Image:
    """Decode -> orient -> flatten -> cap -> letterbox to a `size`x`size` RGB canvas.

    Deterministic and side-effect free (never touches the source file). Raises
    BadImageError on anything it cannot faithfully turn into a product image.
    """
    return letterbox(decode_image(raw), size)


def decode_image(raw: bytes) -> Image.Image:
    """Decode -> orient -> flatten -> cap, at full resolution (detection needs it)."""
    if not raw:
        raise BadImageError("empty image payload")
    if sniff_mime(raw) is None:
        raise UnsupportedImageError("unsupported image type (JPEG, PNG or WebP only)")
    try:
        img = Image.open(io.BytesIO(raw))
        fmt = img.format
        if fmt not in ALLOWED_FORMATS:
            raise UnsupportedImageError(f"unsupported image format: {fmt}")
        if img.width * img.height > MAX_PIXELS:
            raise ImageTooLargeError(
                f"image is {img.width}x{img.height}; the limit is {MAX_PIXELS} pixels")
        # Honour EXIF orientation, then force a full decode so corruption surfaces now.
        img = ImageOps.exif_transpose(img)
        img.load()
    except BadImageError:
        raise
    except Image.DecompressionBombError as exc:
        raise ImageTooLargeError(f"image exceeds maximum allowed resolution: {exc}") from exc
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
    return img


def letterbox(img: Image.Image, size: int = 224) -> Image.Image:
    """Aspect-preserving resize + centre-pad to the square model canvas."""
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
    # Not an image at all, and an image type we do not take -> 415.
    for junk in (b"GIF89a" + b"\0" * 20, b"%PDF-1.7"):
        try:
            decode_image(junk); assert False, "expected UnsupportedImageError"
        except UnsupportedImageError:
            pass
    print("preprocessing self-check OK")
