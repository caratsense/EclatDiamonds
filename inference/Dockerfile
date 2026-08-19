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

# Optional: bake the weights into the image so cold starts don't download.
# Uncomment and pass build args, or let them download to the mounted /models volume at boot.
# RUN python -c "from transformers import AutoModel; AutoModel.from_pretrained('facebook/dinov2-base'); AutoModel.from_pretrained('google/siglip2-base-patch16-224')"

EXPOSE 8000
# Railway injects $PORT; default 8000 locally. Single worker: models are big, RAM-bound.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
