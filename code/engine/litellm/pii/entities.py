from typing import Final

from litellm.pii.detection.ner_labels import EXTENDED_ENTITY_TYPES
from litellm.types.guardrails import PiiEntityType

ENTITY_VOCABULARY: Final[frozenset[str]] = frozenset(member.value for member in PiiEntityType) | EXTENDED_ENTITY_TYPES
