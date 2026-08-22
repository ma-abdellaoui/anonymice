# NER stage for PII detection. The model is downloaded at build time, not at
# start: it is mandatory for name detection, so a container that boots without
# it would leave the proxy failing closed on every request.
FROM python:3.12-slim AS base

ENV PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/hf \
    TRANSFORMERS_VERBOSITY=error \
    TOKENIZERS_PARALLELISM=false

WORKDIR /app

# Pinned as build args so a second image can be built for a model that needs a
# newer runtime, without forking this file. openai/privacy-filter, for one,
# declares model_type "openai_privacy_filter", which older transformers cannot
# construct at all.
ARG TORCH_VERSION=2.6.0
ARG TRANSFORMERS_VERSION=4.48.3

RUN pip install --no-cache-dir \
        "torch==${TORCH_VERSION}" \
        "transformers==${TRANSFORMERS_VERSION}" \
        "fastapi==0.115.8" \
        "uvicorn[standard]==0.34.0"

# Changing this also needs a matching label map: map_label covers Piiranha's
# vocabulary only, and unmapped labels are dropped silently.
ARG PII_NER_MODEL=iiiorg/piiranha-v1-detect-personal-information
ENV PII_NER_MODEL=${PII_NER_MODEL}

# Bake the weights in. The build fails here if the model cannot be fetched,
# which is the point: a silently model-less image is the failure we are
# preventing.
RUN python -c "\
from transformers import AutoModelForTokenClassification, AutoTokenizer; \
import os; m = os.environ['PII_NER_MODEL']; \
AutoTokenizer.from_pretrained(m); \
AutoModelForTokenClassification.from_pretrained(m); \
print('model cached:', m)"

COPY server.py /app/server.py

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=6 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
