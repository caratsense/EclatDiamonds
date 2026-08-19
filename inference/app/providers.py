"""Embedding providers.

`EmbeddingProvider` is the abstraction the service talks to. Two concrete image
towers today (DINO for fine-grained structure/geometry, SigLIP 2 for semantics);
a future `GeminiEmbeddingProvider` slots in by subclassing without touching main.py.

Each model is loaded ONCE at startup. Preprocessing (geometry/colour/hash) happens
upstream in preprocessing.py — providers receive an already-normalized square RGB
PIL image and only apply their own model-specific tensor normalization + pooling.
"""
from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod

import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModel

log = logging.getLogger("inference.providers")

# CPU-only container: keep torch from oversubscribing the box.
torch.set_num_threads(int(os.getenv("TORCH_NUM_THREADS", str(os.cpu_count() or 4))))
torch.set_grad_enabled(False)


class EmbeddingProvider(ABC):
    """One model. Load once, embed batches of pre-normalized PIL images."""

    def __init__(self, model_id: str, cache_dir: str | None, hf_token: str | None):
        self.model_id = model_id
        self._cache_dir = cache_dir
        self._hf_token = hf_token
        self.processor = None
        self.model = None
        self.dim: int | None = None
        self.loaded = False

    @property
    @abstractmethod
    def name(self) -> str:
        """Stable key ('dino' / 'siglip') used in the HTTP contract."""

    def load(self) -> None:
        """Fetch + init the model, then probe it to confirm it runs and learn dim."""
        kw = dict(cache_dir=self._cache_dir, token=self._hf_token)
        self.processor = AutoImageProcessor.from_pretrained(self.model_id, use_fast=True, **kw)
        self.model = AutoModel.from_pretrained(self.model_id, **kw).eval()
        # Probe with a tiny white tile: validates the forward path and fixes self.dim.
        probe = Image.new("RGB", (64, 64), (255, 255, 255))
        self.dim = int(self.embed_batch([probe])[0].shape[0])
        self.loaded = True
        log.info("loaded model", extra={"provider": self.name, "model_id": self.model_id, "dim": self.dim})

    @abstractmethod
    def _encode(self, inputs) -> torch.Tensor:
        """Model-specific forward + pooling -> (batch, dim) tensor."""

    def embed_batch(self, images: list[Image.Image]) -> list[np.ndarray]:
        """Return one L2-normalized float32 vector per input image."""
        inputs = self.processor(images=images, return_tensors="pt")
        with torch.inference_mode():
            feats = self._encode(inputs).float()
        feats = torch.nn.functional.normalize(feats, p=2, dim=1)
        arr = feats.cpu().numpy().astype(np.float32)
        return [arr[i] for i in range(arr.shape[0])]

    def embed(self, image: Image.Image) -> np.ndarray:
        return self.embed_batch([image])[0]


class DinoV3EmbeddingProvider(EmbeddingProvider):
    """DINO image tower — fine-grained visual/structure/geometry representation.

    Model id is env-driven (DINO_MODEL_ID). Defaults to DINOv2 (Apache-2.0, ungated)
    for deploy safety; set DINO_MODEL_ID=facebook/dinov3-vitb16-pretrain-lvd1689m
    (+ HF_TOKEN, gated) to run DINOv3. Pooling is the CLS pooler_output, identical
    across v2/v3, so this one class serves both. See README for the licence trade-off.
    """

    @property
    def name(self) -> str:
        return "dino"

    def _encode(self, inputs) -> torch.Tensor:
        out = self.model(**inputs)
        # dinov2/v3 expose a CLS pooler_output; fall back to CLS token if absent.
        pooled = getattr(out, "pooler_output", None)
        if pooled is None:
            pooled = out.last_hidden_state[:, 0]
        return pooled


class SigLIP2EmbeddingProvider(EmbeddingProvider):
    """SigLIP 2 image tower — complementary semantic representation (images only)."""

    @property
    def name(self) -> str:
        return "siglip"

    def _encode(self, inputs) -> torch.Tensor:
        # Siglip2Model.get_image_features gives the pooled image embedding.
        return self.model.get_image_features(**inputs)
