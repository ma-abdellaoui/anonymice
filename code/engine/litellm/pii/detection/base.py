from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from litellm.pii.types import DetectionError, PiiSpan


@runtime_checkable
class PiiDetector(Protocol):
    """One detection stage.

    Implementations differ in wire format (Presidio ``/analyze`` versus a
    HuggingFace token-classification pipeline) but all normalize to spans that
    index the original text.
    """

    async def detect(
        self,
        text: str,
        language: str,
        entities: Sequence[str] | None,
    ) -> tuple[PiiSpan, ...] | DetectionError: ...
