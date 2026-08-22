"""HuggingFace token-classification server for the PII NER stage.

Speaks the contract PiiranhaDetector expects: ``{"inputs": text}`` in,
``[{entity_group, score, start, end}]`` out.
"""

import os
from typing import Final

from fastapi import FastAPI
from pydantic import BaseModel
from transformers import pipeline

MODEL: Final = os.environ.get("PII_NER_MODEL", "iiiorg/piiranha-v1-detect-personal-information")

app: Final = FastAPI(title="PII NER stage")
_ner = pipeline("token-classification", model=MODEL, aggregation_strategy="simple")


class Request(BaseModel):
    inputs: str


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL}


@app.post("/")
def detect(request: Request) -> list[dict[str, object]]:
    return [
        {
            "entity_group": item["entity_group"],
            "score": float(item["score"]),
            "start": int(item["start"]),
            "end": int(item["end"]),
        }
        for item in _ner(request.inputs)
    ]
