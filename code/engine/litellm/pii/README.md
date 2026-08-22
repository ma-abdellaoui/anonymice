# PII anonymization

Reversible PII handling: detect, replace with a token, send to the provider, restore on the way back.

There is one implementation of detect / encode / decode, in `PiiService`. The guardrail hook and the REST
endpoints are both thin adapters over it, so what a browser extension gets from `/pii/encode` is by
construction what an in-flight completion gets.

## Layout

```
types.py                 frozen dataclasses and the error unions
detection/               PiiDetector protocol, the two stages, the cascade, span merging
codec/                   PiiCodec protocol, the token formats, the text transform
store/                   token stores plus the at-rest cipher
service.py               PiiService: the single entry point
config.py                settings and the object graph
deploy/                  docker compose for the two detection tiers
```

## Detection

Stage one is Presidio pinned to its pattern and checksum recognizers: deterministic, no model, low latency.
Pinning the entity list matters, because an analyzer that also loads an NLP engine would otherwise return
NER entities from the stage we treat as high precision.

Stage two is a token-classification model (`iiiorg/piiranha-v1-detect-personal-information`) reached over the
standard HuggingFace pipeline contract, covering what patterns cannot: PERSON, LOCATION, and friends. Its label
vocabulary differs from Presidio's, so `piiranha_labels.py` maps it onto ours and drops anything unmapped, which
means a model upgrade can never inject an unknown entity type.

`ner_stage_policy` decides when stage two runs. The default, `on_miss`, only calls it when the rule stage found
nothing, so most requests pay only for the cheap pass.

Overlaps resolve deterministically: higher score wins, ties go to the rule stage, then to the longer span. Same
entity fragments separated by a single space then coalesce, so a given name and surname become one `<PERSON_1>`
rather than two tokens.

A detector that cannot be reached fails closed by default. Returning "no PII found" when the scanner is down is
the one failure mode that silently leaks.

## Encoding

Two lifetimes, deliberately different:

| | LLM path (guardrail) | Endpoint path (extension) |
|---|---|---|
| Lives | one request | until the TTL expires |
| Store | request metadata | Redis-backed cache, values sealed with AES-256-GCM |
| Token | `<PERSON_1>` | `<PERSON:3f9c2e1b8d4a7f60>` |

Short typed placeholders keep model output quality high, which opaque ciphertext in the prompt destroys. Random
handles on the endpoint path carry no information about the value, so identical inputs never produce identical
tokens and nothing leaks by comparison; deleting the store entry kills the token permanently.

`EncryptedCodec` carries its own ciphertext and needs no store at all. It ships as the seam for a
bring-your-own scheme and is not the default on either path.

Within a single call, repeated occurrences of the same value share one token, so the model still sees that two
mentions refer to the same person. That reuse never spans calls.

## Entity actions

`BLOCK` rejects the request, `MASK` redacts irreversibly, `ENCODE` is the reversible path. Masked entities get a
bare `<PERSON>` with no ordinal or handle, which the token pattern deliberately does not match, so masking is
irreversible by construction rather than by remembering not to store the mapping. Unlisted entities default to
`ENCODE`.

## Configuration

Run the detection tiers with `docker compose -f litellm/pii/deploy/docker-compose.pii.yml up -d`, then add the
guardrail:

```yaml
guardrails:
  - guardrail_name: pii-anonymizer
    litellm_params:
      guardrail: pii_anonymizer
      mode: [pre_call, post_call]
      presidio_analyzer_api_base: http://localhost:3000
      pii_ner_api_base: http://localhost:8080
      pii_ner_stage_policy: on_miss
      pii_codec: placeholder
      pii_entities_config:
        CREDIT_CARD: BLOCK
        US_SSN: MASK
        PERSON: ENCODE
```

Environment variables: `PRESIDIO_ANALYZER_API_BASE`, `LITELLM_PII_NER_API_BASE`,
`LITELLM_PII_NER_STAGE_POLICY`, `LITELLM_PII_SESSION_TTL_SECONDS`, and `LITELLM_PII_ENCRYPTION_KEY`. Without the
encryption key, stored values are not sealed at rest.

## Endpoints

```
POST /pii/detect   {texts, language?, entities?}  -> {results: [{spans, ner_stage_ran}]}
POST /pii/encode   {texts, session_id?, ...}      -> {texts, session_id, tokens}
POST /pii/decode   {texts, session_id}            -> {texts}
```

Decode hands back real PII, so it is gated on the `allow_pii_decode` key permission and scoped to the calling
key. A valid `session_id` alone never reads another key's tokens.
