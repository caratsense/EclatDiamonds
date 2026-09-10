# CPU-only inference image for the jewelry embedding service.
FROM python:3.11-slim

# libgl/glib not needed (Pillow-only decode). Keep the layer minimal.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    MODEL_CACHE_DIR=/models \
    HF_HOME=/models

WORKDIR /app

COPY requirements.txt .
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

COPY app ./app

# Bake the weights into the image. This is not an optimisation -- it is what makes
# Railway's Serverless (app-sleep) usable on this service. There is no volume on
# /models, so without this every wake re-downloads ~700MB from HuggingFace before
# it can answer, which outlasts any sensible client timeout. Baked, a cold start
# is just two loads from local disk.
#
# The processors are fetched too: providers.py calls AutoImageProcessor as well as
# AutoModel, and a missing processor would send the container to the network on
# the exact request we are trying to keep fast.
RUN python -c "from transformers import AutoModel, AutoImageProcessor; [ (AutoModel.from_pretrained(m), AutoImageProcessor.from_pretrained(m, use_fast=True))   for m in ('facebook/dinov2-base', 'google/siglip2-base-patch16-224') ]"

EXPOSE 8000
# Railway injects $PORT; default 8000 locally. Single worker: models are big, RAM-bound.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
