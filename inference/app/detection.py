"""Find the jewellery in a picture before anything describes it.

The embedders describe a whole canvas. A pendant photographed on a velvet stand
is ~15% of its frame, so its vector is mostly velvet; a Gati CAD sheet is five
small renders plus dimension callouts, so its vector is mostly "technical
drawing". Neither vector is the piece, and the two never match each other.

An open-vocabulary detector (Grounding DINO, prompted with jewellery words)
boxes each piece — the pendant on the stand, every render on a sheet, the ring
on a hand — and ignores what is not jewellery: velvet, skin, callout text, the
part number. Each box is cropped and embedded as a view of its own, next to the
whole picture, and a design is matched on its best view against the query's.

Tried on the shop's own pictures before choosing: it found every render on the
Gati sheets (white and rose metal included, which the old saturation heuristic
missed) and the "A" on the velvet stand, where a saliency/background-removal
model would have kept the stand as "the object". OWLv2 was the alternative and
was several times slower on CPU for no better boxes.
"""
from __future__ import annotations

import logging
import os

import torch
from PIL import Image
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

log = logging.getLogger("inference.detection")

# Lower-case, period-separated: the format Grounding DINO's text side expects.
PROMPT = "jewelry. pendant. ring. earring. necklace. bracelet. bangle."
BOX_THRESHOLD = float(os.getenv("DETECT_BOX_THRESHOLD", "0.25"))
TEXT_THRESHOLD = float(os.getenv("DETECT_TEXT_THRESHOLD", "0.2"))
# Detection needs the layout, not the pixels: work on a copy this size.
DETECT_SIDE = 1024
# A box smaller than this share of the picture's long side is a stone or a
# speck, not a view worth describing.
MIN_SIDE_FRAC = 0.03
# A box covering this much of the picture IS the picture; the whole-image
# vector already describes it.
MAX_AREA_FRAC = 0.85
# Context kept around each box, as a share of its size: the embedders were
# trained on objects with some ground around them, not on edge-to-edge crops.
PAD_FRAC = 0.08

Box = tuple[float, float, float, float, float]  # x0, y0, x1, y1, score (pixels)


def _area(b) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _inter(a, b) -> float:
    return _area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def select_views(dets: list[Box], w: int, h: int, max_views: int) -> list[Box]:
    """Turn raw detections into the views worth embedding, best first.

    Pure (no model) so it can be checked on its own — see __main__.
    """
    long_side = max(w, h)
    boxes = []
    for x0, y0, x1, y1, s in dets:
        x0, y0, x1, y1 = max(0.0, x0), max(0.0, y0), min(float(w), x1), min(float(h), y1)
        if min(x1 - x0, y1 - y0) < MIN_SIDE_FRAC * long_side:
            continue
        if (x1 - x0) * (y1 - y0) > MAX_AREA_FRAC * w * h:
            continue
        boxes.append((x0, y0, x1, y1, s))

    # Greedy NMS: the prompt names six kinds of piece, so one pendant can come
    # back as "jewelry" AND "pendant" with near-identical boxes.
    boxes.sort(key=lambda b: -b[4])
    kept: list[Box] = []
    for b in boxes:
        if all(_inter(b, k) / (_area(b) + _area(k) - _inter(b, k) + 1e-9) <= 0.5 for k in kept):
            kept.append(b)

    # A box that wraps two or more others is the group, not a piece: the whole
    # sheet's worth of renders, or chain-plus-pendant around the pendant and its
    # bail. The pieces inside are the views.
    def inside(small, big) -> bool:
        return small is not big and _inter(small, big) >= 0.85 * _area(small)

    kept = [b for b in kept if sum(inside(o, b) for o in kept) < 2]
    return kept[:max_views]


def crop_view(img: Image.Image, box: Box) -> Image.Image:
    x0, y0, x1, y1 = box[:4]
    px, py = (x1 - x0) * PAD_FRAC, (y1 - y0) * PAD_FRAC
    return img.crop((
        int(max(0, x0 - px)), int(max(0, y0 - py)),
        int(min(img.width, x1 + px)), int(min(img.height, y1 + py)),
    ))


class JewelryDetector:
    """Grounding DINO, loaded once. `views()` never raises: a detector problem
    must degrade to whole-image search, not break it."""

    def __init__(self, model_id: str, cache_dir: str | None, hf_token: str | None):
        self.model_id = model_id
        self._kw = dict(cache_dir=cache_dir, token=hf_token)
        self.loaded = False

    def load(self) -> None:
        self.processor = AutoProcessor.from_pretrained(self.model_id, **self._kw)
        self.model = AutoModelForZeroShotObjectDetection.from_pretrained(self.model_id, **self._kw).eval()
        self._detect(Image.new("RGB", (64, 64), (255, 255, 255)))  # probe the forward path
        self.loaded = True
        log.info("loaded detector %s", self.model_id)

    def _detect(self, img: Image.Image) -> list[Box]:
        work = img.copy()
        work.thumbnail((DETECT_SIDE, DETECT_SIDE))
        inputs = self.processor(images=work, text=PROMPT, return_tensors="pt")
        with torch.inference_mode():
            out = self.model(**inputs)
        r = self.processor.post_process_grounded_object_detection(
            out, inputs.input_ids, threshold=BOX_THRESHOLD, text_threshold=TEXT_THRESHOLD,
            target_sizes=[work.size[::-1]],
        )[0]
        sx, sy = img.width / work.width, img.height / work.height
        return [
            (b[0] * sx, b[1] * sy, b[2] * sx, b[3] * sy, float(s))
            for b, s in zip(r["boxes"].tolist(), r["scores"].tolist())
        ]

    def views(self, img: Image.Image, max_views: int) -> list[tuple[Box, Image.Image]]:
        if not self.loaded or max_views <= 0:
            return []
        try:
            boxes = select_views(self._detect(img), img.width, img.height, max_views)
        except Exception:
            log.exception("detection failed; falling back to the whole image")
            return []
        return [(b, crop_view(img, b)) for b in boxes]


if __name__ == "__main__":
    # Selection rules only — no model, no network.
    W, H = 1000, 800
    whole = (0, 0, 1000, 800, 0.9)                     # the picture itself
    speck = (10, 10, 20, 20, 0.9)                      # a stone
    a = (100, 100, 300, 300, 0.6)
    a_dup = (105, 102, 298, 305, 0.5)                  # same piece, other label
    b = (500, 100, 700, 400, 0.55)
    group = (90, 90, 710, 410, 0.4)                    # wraps a and b
    got = select_views([whole, speck, a, a_dup, b, group], W, H, max_views=6)
    assert got == [a, b], got
    assert select_views([a, b], W, H, max_views=1) == [a]
    # A pendant inside a chain box: one inner box does not make a group.
    chain = (80, 80, 320, 700, 0.3)
    assert select_views([a, chain], W, H, 6) == [a, chain]
    print("detection self-check OK")
