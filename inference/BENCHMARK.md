# Inference benchmark

Script: `bench/bench.py` (see its docstring). Run 2026-09-18.

## Machine
- AMD Ryzen 5 5600H (6 cores / 12 threads), 15.3 GB RAM, Windows 11, Python 3.11.9,
  torch 2.9.0+cpu, transformers 4.57.1, `TORCH_NUM_THREADS` = 12 (default), no torchvision
  (slow image processor), weights from the local HF cache (`HF_HUB_OFFLINE=1`).
- **The CPU was shared.** Other agents' inference servers and indexers were running
  on the same box. Total CPU was 28-74% busy right before each run and 100% at times during
  it. Read the absolute numbers as an upper bound. The comparison between modes is the useful
  part. Railway CPU will differ, so re-run there before quoting SLAs.

## Latency (`/embed/batch`, warm, frontend-sized JPEGs <=1600px q85)
Same 3 catalogue images every run (seeded). `stage_p50` = server `timings_ms`, summed over the batch.

| DETECT_MODE | cold start (spawn -> /health ok) | first request | 1 img p50 / p95 | 3 img p50 / p95 | detect p50 (1 / 3) | dino p50 (1 / 3) | siglip p50 (1 / 3) | views (1 / 3) |
|---|---|---|---|---|---|---|---|---|
| off    | 50.8 s | 0.5 s  | 788 ms / 931 ms   | 2.53 s / 6.49 s  | 0 / 0          | 328 / 1336 ms | 332 / 1200 ms | 0 / 0 |
| auto   | 34.1 s | 10.6 s | 9.33 s / 11.68 s  | 18.9 s / 22.3 s  | 7.46 / 15.8 s  | 785 / 1775 ms | 674 / 1406 ms | 2 / 5 |
| always | 21.6 s | 13.1 s | 11.76 s / 22.71 s | 25.0 s / 29.2 s  | 8.42 / 20.7 s  | 846 / 2277 ms | 706 / 1800 ms | 2 / 9 |

Runs: off 8, auto 6, always 6 per size, after one warm-up. Decode is under 70 ms for 3 images.
Cold start varies with background load and the OS file cache. It measures model load from local
disk, not a Railway wake. The three modes were started one after another, so later ones found the
weights already in the file cache.

**What this shows:** the Grounding DINO detector takes about 75-85% of warm latency. One image
costs about 0.7 s without detection and about 8 s with it on this contended box. In this sample,
`auto` skipped the detector for 1 of the 3 images. The 1-image sample needed detection, so auto
matched always there.

## Recall (`python bench/bench.py recall --gallery 100 --queries 30`)
- **Gallery:** 100 images, a seeded subset of the 749 byte-unique product images under
  `backend/uploads` (`catalogue/`, `products/`, `org/*/catalogue/`). Nothing from visits,
  attendance or covers. The gallery has 457 index rows: 100 whole images plus 357 detected views.
- **Queries:** 30 seeded gallery images x 3 synthetic variants = 90 queries. `crop` is a random
  62-80% window. `rotate` is +-8-20 deg with a white fill. `small` puts the image at 30% of a
  synthetic textured backdrop (velvet, wood or grey noise, with no real photos). All are sent as
  1600px q85 JPEGs, like the frontend.
- **Label:** the source file. A design is scored on its best (query vector, design row) pair
  using `(0.5*cos_dino + 0.4*cos_siglip)/0.9`, which mirrors the backend's closeness merge.
  The no-match gating is not applied.
- The `auto` gate chose detection for 55/100 gallery images, 30/30 crop queries,
  26/30 rotate queries and 30/30 small queries.

| pipeline | crop r@1 / r@5 | rotate r@1 / r@5 | small r@1 / r@5 | **all r@1 / r@5** |
|---|---|---|---|---|
| whole image only (`off`) | 1.000 / 1.000 | 1.000 / 1.000 | 0.133 / 0.333 | **0.711 / 0.778** |
| detection (`always`, index + query) | 0.967 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | **0.989 / 1.000** |
| `auto` on queries, index built with `always` | 0.967 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 | **0.989 / 1.000** |
| `auto` on queries and index | 0.967 / 1.000 | 1.000 / 1.000 | 0.767 / 0.833 | **0.911 / 0.944** |

**Decision: the default stays `DETECT_MODE=always`.**
- Detection is what makes a small-in-frame piece findable. Recall@1 goes from 0.13 to 1.00 on
  `small`. It costs one crop miss at r@1: a partial crop's own view ranks a neighbour's view first.
- `auto` on queries only matched `always` exactly, but it skipped detection for just 4 of the 90
  queries, all of them rotations. Most catalogue shots are sparse CAD sheets on white, which the
  gate correctly sends to detection. So on this data `auto` saves almost nothing.
- `auto` on the index loses 23 points of r@1 on small-in-frame queries. That happens because
  images it judges "full-frame" get no views, and those views are what a small query matches.
  **Never build the index under `auto`.** The README says the same.
- Caveats: this is a small sample (100 gallery images, 90 queries) and the queries are synthetic.
  Real customer phone photos may differ. Near-identical designs stored as different files would
  count as misses; none showed up here.

## ONNX / INT8 / OpenVINO
Probe: torch dynamic INT8 (`quantize_dynamic` on `nn.Linear`, no new dependency).
40 catalogue canvases, 5-canvas forward pass (the 1 image + 4 views shape), CPU about 14% busy
before the run:

| tower | fp32 | int8 | cos(fp32, int8) mean / min | int8 vector finds its own fp32 twin among 40 |
|---|---|---|---|---|
| DINOv2-base | 1045 ms | 702 ms | 0.139 / 0.071 | 10% |
| SigLIP2-base | 923 ms | 578 ms | 0.688 / 0.596 | 27.5% |

**Rejected.** Naive dynamic INT8 destroys the embedding space. It would also force a full
re-index, it would need calibration or static quantization with a recall check, and it only
saves about 35% of the embedding stage.
The embedding stage is the small part of latency anyway: detection is 75-85% of it.
ONNX Runtime and OpenVINO were **not** tried. `optimum` and `openvino` are not installed, and
`onnxruntime` is not in `requirements.txt`. Without a recall-verified export they would be a
heavy new dependency with no evidence behind them. If latency matters, the bigger lever is the
detector. Grounding DINO's processor resizes to an 800px short edge, so shrinking it or batching
detection across images is worth benchmarking first, and every such change needs this recall
bench re-run.
