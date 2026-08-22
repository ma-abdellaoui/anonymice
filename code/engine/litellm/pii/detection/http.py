from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Protocol, runtime_checkable

from litellm.llms.custom_httpx.http_handler import get_async_httpx_client
from litellm.types.llms.custom_http import httpxSpecialProvider

DEFAULT_DETECTOR_TIMEOUT_SECONDS: Final = 10.0
JSON_HEADERS: Final[dict[str, str]] = {"Accept": "application/json"}  # mutable-ok: httpx requires a plain dict


@dataclass(frozen=True, slots=True)
class JsonResponse:
    status_code: int
    body: object


@dataclass(frozen=True, slots=True)
class TransportFailure:
    reason: str


@runtime_checkable
class JsonPoster(Protocol):
    """Narrow seam over HTTP so detectors can be unit tested with a fake."""

    async def post_json(self, url: str, payload: Mapping[str, object]) -> JsonResponse | TransportFailure: ...


@dataclass(frozen=True, slots=True)
class HttpxJsonPoster:
    timeout_seconds: float = DEFAULT_DETECTOR_TIMEOUT_SECONDS

    async def post_json(self, url: str, payload: Mapping[str, object]) -> JsonResponse | TransportFailure:
        client: Final = get_async_httpx_client(llm_provider=httpxSpecialProvider.GuardrailCallback)
        try:
            response: Final = await client.post(
                url=url,
                json=dict(payload),  # mutable-ok: httpx serializes its json= argument from a plain dict
                headers=JSON_HEADERS,
                timeout=self.timeout_seconds,
            )
        except Exception as exc:
            return TransportFailure(reason=f"{type(exc).__name__}")

        content_type: Final = response.headers.get("Content-Type", "")
        if "application/json" not in content_type:
            return TransportFailure(reason=f"non-JSON Content-Type '{content_type}'")
        try:
            return JsonResponse(status_code=response.status_code, body=response.json())
        except Exception as exc:
            return TransportFailure(reason=f"malformed JSON body ({type(exc).__name__})")
