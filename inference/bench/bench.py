"""Latency + recall benchmark for the embedding service. Results -> ../BENCHMARK.md (by hand).

  python bench/bench.py latency [--modes always,auto,off] [--port 8010] [--runs 20]
      Spawns uvicorn per DETECT_MODE (HF_HUB_OFFLINE=1), measures cold start
      (spawn -> /health ok), then warm p50/p95 of /embed/batch with 1 and 3 images.

  python bench/bench.py recall [--queries 150]
      In-process. Gallery = every product image under backend/uploads (catalogue/,
      products/, org/*/catalogue/ — never visits/attendance/covers), deduped by
      bytes. Queries = synthetic variants of a seeded sample of gallery images:
      crop (random ~70% window), rotate (+-8..20 deg, white fill), small (the
      image at ~30% of a textured backdrop). Label = the source file.
      Scoring mirrors the backend: a design scores its best (query vector,
      design row) pair on (0.5*cos_dino + 0.4*cos_siglip)/0.9.

Embeddings are cached per image in bench/.cache (gitignored), so a run resumes.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import random
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
UPLOADS = ROOT.parent / "backend" / "uploads"
CACHE = HERE / ".cache"
sys.path.insert(0, str(ROOT))


def product_images() -> list[Path]:
    dirs = [UPLOADS / "catalogue", UPLOADS / "products", *sorted((UPLOADS / "org").glob("*/catalogue"))]
    seen, out = set(), []
    for d in dirs:
        for p in sorted(d.rglob("*")):
            if p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
                continue
            h = hashlib.sha256(p.read_bytes()).hexdigest()
            if h not in seen:
                seen.add(h); out.append(p)
    return out


def jpeg(img: Image.Image, side=1600, q=85) -> bytes:
    """What the frontend sends: <=1600px, JPEG q>=0.85."""
    img = img.convert("RGB"); img.thumbnail((side, side))
    buf = io.BytesIO(); img.save(buf, "JPEG", quality=q)
    return buf.getvalue()


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(p / 100 * (len(xs) - 1)))]


# ---------------------------------------------------------------- latency
def _get(url, key):
    req = urllib.request.Request(url, headers={"x-api-key": key})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def _post(url, body, key):
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"content-type": "application/json", "x-api-key": key})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def latency(args):
    imgs = product_images()
    rng = random.Random(7)
    sample = [jpeg(Image.open(p)) for p in rng.sample(imgs, 3)]
    bodies = {n: json.dumps({"images": [{"id": str(i), "image_b64": base64.b64encode(b).decode(), "mime": "image/jpeg"}
                                         for i, b in enumerate(sample[:n])]}).encode() for n in (1, 3)}
    key, base = "bench-key", f"http://127.0.0.1:{args.port}"
    report = {}
    for mode in args.modes.split(","):
        env = {**os.environ, "HF_HUB_OFFLINE": "1", "DETECT_MODE": mode, "INFERENCE_API_KEY": key, "LOG_LEVEL": "WARNING"}
        t0 = time.perf_counter()
        proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(args.port)],
                                cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            while True:
                try:
                    if _get(f"{base}/health", key)["status"] == "ok":
                        break
                except OSError:
                    pass
                if proc.poll() is not None or time.perf_counter() - t0 > 600:
                    raise RuntimeError(f"server did not come up (mode={mode})")
                time.sleep(0.25)
            cold = time.perf_counter() - t0
            t1 = time.perf_counter(); _post(f"{base}/embed/batch", bodies[1], key)
            first = (time.perf_counter() - t1) * 1000
            r = {"cold_start_s": round(cold, 1), "first_request_ms": round(first)}
            for n, body in bodies.items():
                _post(f"{base}/embed/batch", body, key)  # warm-up
                wall, stages = [], []
                for _ in range(args.runs):
                    t = time.perf_counter(); out = _post(f"{base}/embed/batch", body, key)
                    wall.append((time.perf_counter() - t) * 1000); stages.append(out["timings_ms"])
                    views = sum(len(x["views"]) for x in out["results"])
                r[f"{n}img"] = {
                    "wall_p50": round(pct(wall, 50)), "wall_p95": round(pct(wall, 95)), "views": views,
                    **{f"{k}_p50": round(pct([s[k] for s in stages], 50)) for k in stages[0]},
                }
            report[mode] = r
            print(mode, json.dumps(r), flush=True)
        finally:
            proc.terminate(); proc.wait()
    print(json.dumps(report, indent=1))


# ---------------------------------------------------------------- recall
BACKDROPS = ("velvet", "wood", "grey")


def backdrop(kind: str, size: int, rng: np.random.Generator) -> Image.Image:
    """Synthetic textured grounds (no real photos): velvet-green noise, wood-ish
    stripes, mottled grey counter."""
    n = rng.normal(0, 1, (size // 8, size // 8, 1))
    if kind == "velvet":
        base, amp = np.array([20, 90, 45]), 25
    elif kind == "wood":
        n = n + np.sin(np.linspace(0, 40, size // 8))[None, :, None] * 2
        base, amp = np.array([120, 80, 45]), 18
    else:
        base, amp = np.array([150, 150, 145]), 20
    arr = np.clip(base + amp * n, 0, 255).astype(np.uint8)
    return Image.fromarray(arr).resize((size, size), Image.BICUBIC).filter(ImageFilter.GaussianBlur(2))


def variants(img: Image.Image, rng: np.random.Generator) -> dict[str, Image.Image]:
    img = img.convert("RGB"); img.thumbnail((1600, 1600))
    w, h = img.size
    f = rng.uniform(0.62, 0.8)
    cw, ch = int(w * f), int(h * f)
    x, y = int(rng.integers(0, w - cw + 1)), int(rng.integers(0, h - ch + 1))
    crop = img.crop((x, y, x + cw, y + ch))
    ang = float(rng.uniform(8, 20)) * (1 if rng.random() < 0.5 else -1)
    rot = img.rotate(ang, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))
    S = 1400
    bg = backdrop(BACKDROPS[int(rng.integers(0, 3))], S, rng)
    small = img.copy(); small.thumbnail((int(S * 0.3), int(S * 0.3)))
    bg.paste(small, (int(rng.integers(0, S - small.width)), int(rng.integers(0, S - small.height))))
    return {"crop": crop, "rotate": rot, "small": bg}


class Pipe:
    def __init__(self):
        from app import main
        from app.detection import JewelryDetector
        from app.providers import DinoV3EmbeddingProvider, SigLIP2EmbeddingProvider
        self.m = main
        self.dino = DinoV3EmbeddingProvider(main.DINO_MODEL_ID, main.MODEL_CACHE_DIR, None); self.dino.load()
        self.sig = SigLIP2EmbeddingProvider(main.SIGLIP_MODEL_ID, main.MODEL_CACHE_DIR, None); self.sig.load()
        self.det = JewelryDetector(main.DETECTOR_MODEL_ID, main.MODEL_CACHE_DIR, None); self.det.load()

    def run(self, raw: bytes):
        """-> (dino rows, siglip rows, needs_detection); row 0 whole, then views."""
        from app.detection import needs_detection
        from app.preprocessing import decode_image, letterbox
        full = decode_image(raw)
        canv = [letterbox(full, 224)] + [letterbox(c, 224) for _, c in self.det.views(full, self.m.MAX_VIEWS)]
        return (np.stack(self.dino.embed_batch(canv)), np.stack(self.sig.embed_batch(canv)), needs_detection(full))


def recall(args):
    import pickle
    CACHE.mkdir(exist_ok=True)
    (CACHE / ".gitignore").write_text("*\n")
    gallery = product_images()
    if args.gallery and args.gallery < len(gallery):  # seeded subset, same every run
        gallery = sorted(random.Random(5).sample(gallery, args.gallery))
    print(f"gallery: {len(gallery)} images", flush=True)
    pipe = Pipe()
    # Per-image cache, saved as it goes: a contended machine can take hours.
    cpath = CACHE / "embeddings.pkl"
    cache = pickle.loads(cpath.read_bytes()) if cpath.exists() else {}
    D, S, I, V, N = [], [], [], [], []
    t = time.perf_counter()
    for i, p in enumerate(gallery):
        k = str(p.relative_to(UPLOADS))
        if k not in cache:
            cache[k] = pipe.run(p.read_bytes())
            cpath.write_bytes(pickle.dumps(cache))
        d, s, need = cache[k]
        D.append(d); S.append(s); I += [i] * len(d); V += list(range(len(d))); N.append(need)
        if i % 25 == 0:
            print(f"  gallery {i}/{len(gallery)} {time.perf_counter() - t:.0f}s", flush=True)
    gd, gs, gidx, gview, gneed = np.concatenate(D), np.concatenate(S), np.array(I), np.array(V), np.array(N)
    print(f"gallery rows: {len(gd)} ({int((gview > 0).sum())} views); auto would detect "
          f"{int(gneed.sum())}/{len(gneed)} gallery images", flush=True)

    rng = np.random.default_rng(11)
    picks = rng.choice(len(gallery), size=min(args.queries, len(gallery)), replace=False)
    # Gallery row masks per indexing policy.
    whole_rows = gview == 0
    auto_rows = whole_rows | gneed[gidx]
    modes = {  # name: (gallery row mask, query uses its views?)
        "whole": (whole_rows, lambda need: False),
        "detect": (np.ones_like(whole_rows), lambda need: True),
        "auto (query only; index=detect)": (np.ones_like(whole_rows), lambda need: need),
        "auto (query + index)": (auto_rows, lambda need: need),
    }
    hits = {m: {} for m in modes}
    qneed = {}
    t = time.perf_counter()
    for qi, gi in enumerate(picks):
        for vname, vimg in variants(Image.open(gallery[gi]), rng).items():
            k = f"q:{gallery[gi].relative_to(UPLOADS)}:{vname}"
            if k not in cache:
                cache[k] = pipe.run(jpeg(vimg))
                cpath.write_bytes(pickle.dumps(cache))
            qd, qs, need = cache[k]
            qneed.setdefault(vname, []).append(need)
            sim = (0.5 * qd @ gd.T + 0.4 * qs @ gs.T) / 0.9  # (q rows, gallery rows)
            for m, (rows, use_views) in modes.items():
                q = sim if use_views(need) else sim[:1]
                s = np.where(rows, q.max(axis=0), -9)
                best = np.full(len(gallery), -9.0)
                np.maximum.at(best, gidx, s)
                rank = int((best > best[gi]).sum())  # 0 = top-1
                hits[m].setdefault(vname, []).append(rank)
        if qi % 25 == 0:
            print(f"  query {qi}/{len(picks)} {time.perf_counter() - t:.0f}s", flush=True)

    out = {"gallery_images": len(gallery), "gallery_rows": int(len(gd)), "queries_per_variant": len(picks),
           "auto_detects": {v: f"{sum(n)}/{len(n)}" for v, n in qneed.items()}, "recall": {}}
    for m, per in hits.items():
        allr = [r for rs in per.values() for r in rs]
        row = {v: {"r@1": round(np.mean([r < 1 for r in rs]), 3), "r@5": round(np.mean([r < 5 for r in rs]), 3)}
               for v, rs in per.items()}
        row["all"] = {"r@1": round(np.mean([r < 1 for r in allr]), 3), "r@5": round(np.mean([r < 5 for r in allr]), 3)}
        out["recall"][m] = row
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["latency", "recall"])
    ap.add_argument("--modes", default="always,auto,off")
    ap.add_argument("--port", type=int, default=8010)
    ap.add_argument("--runs", type=int, default=20)
    ap.add_argument("--queries", type=int, default=150)
    ap.add_argument("--gallery", type=int, default=0, help="seeded subset of the gallery (0 = all)")
    a = ap.parse_args()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    (latency if a.what == "latency" else recall)(a)
