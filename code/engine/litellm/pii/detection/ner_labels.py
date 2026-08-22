"""Label vocabularies for the model stage, one per model.

A token-classification model emits whatever labels it was trained on, and they
are not interchangeable: Piiranha says ``SURNAME``, OpenAI's privacy filter says
``private_person``, a CoNLL model says ``PER``. An unmapped label is dropped, so
pointing the NER stage at a new model without giving it a map produces a
detector that finds PII and reports none of it, silently. Every supported model
therefore has an explicit map here, and the map is selected alongside the model.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

ACCOUNT_NUMBER: Final = "ACCOUNT_NUMBER"
ID_CARD_NUMBER: Final = "ID_CARD_NUMBER"
PASSWORD: Final = "PASSWORD"
SECRET: Final = "SECRET"
TAX_NUMBER: Final = "TAX_NUMBER"
USERNAME: Final = "USERNAME"

EXTENDED_ENTITY_TYPES: Final[frozenset[str]] = frozenset(
    (ACCOUNT_NUMBER, ID_CARD_NUMBER, PASSWORD, SECRET, TAX_NUMBER, USERNAME)
)

# BIOES, not just BIO: models using constrained span decoding mark the end of a
# span with E- and a one-token span with S-. Treating those as part of the label
# would leave "E-private_person" unmapped, and therefore dropped.
SPAN_PREFIXES: Final[frozenset[str]] = frozenset(("B", "I", "E", "S"))

PIIRANHA_LABEL_MAP: Final[Mapping[str, str]] = MappingProxyType(
    {
        "ACCOUNTNUM": ACCOUNT_NUMBER,
        "BUILDINGNUM": "LOCATION",
        "CITY": "LOCATION",
        "CREDITCARDNUMBER": "CREDIT_CARD",
        "DATEOFBIRTH": "DATE_TIME",
        "DRIVERLICENSENUM": "US_DRIVER_LICENSE",
        "EMAIL": "EMAIL_ADDRESS",
        "GIVENNAME": "PERSON",
        "IDCARDNUM": ID_CARD_NUMBER,
        "PASSWORD": PASSWORD,
        "SOCIALNUM": "US_SSN",
        "STREET": "LOCATION",
        "SURNAME": "PERSON",
        "TAXNUM": TAX_NUMBER,
        "TELEPHONENUM": "PHONE_NUMBER",
        "USERNAME": USERNAME,
        "ZIPCODE": "LOCATION",
    }
)

# openai/privacy-filter. Its taxonomy is deliberately coarse: eight categories,
# each covering what several Presidio entities split apart. ``account_number``
# stays generic rather than becoming US_BANK_NUMBER, because a label naming the
# wrong country attracts that country's policy, and a Swiss IBAN masked under a
# US rule is destroyed rather than tokenized.
PRIVACY_FILTER_LABEL_MAP: Final[Mapping[str, str]] = MappingProxyType(
    {
        "account_number": ACCOUNT_NUMBER,
        "private_address": "LOCATION",
        "private_date": "DATE_TIME",
        "private_email": "EMAIL_ADDRESS",
        "private_person": "PERSON",
        "private_phone": "PHONE_NUMBER",
        "private_url": "URL",
        "secret": SECRET,
    }
)

LABEL_MAPS: Final[Mapping[str, Mapping[str, str]]] = MappingProxyType(
    {
        "piiranha": PIIRANHA_LABEL_MAP,
        "privacy_filter": PRIVACY_FILTER_LABEL_MAP,
    }
)

DEFAULT_LABEL_MAP_NAME: Final = "piiranha"

NER_ONLY_ENTITIES: Final[frozenset[str]] = frozenset(
    entity for mapping in LABEL_MAPS.values() for entity in mapping.values()
)


def normalize_label(raw_label: str) -> str:
    """Strip the span prefix a non-aggregated pipeline emits (``B-CITY`` -> ``CITY``)."""
    head, separator, tail = raw_label.partition("-")
    return tail if separator and head in SPAN_PREFIXES else raw_label


def label_map_by_name(name: str | None) -> Mapping[str, str]:
    """The named vocabulary, falling back to the default rather than to nothing.

    An unknown name must not resolve to an empty map: that would silently
    disable the whole stage instead of failing loudly at the wrong setting.
    """
    return LABEL_MAPS.get(name or DEFAULT_LABEL_MAP_NAME, PIIRANHA_LABEL_MAP)


def map_label(raw_label: str, label_map: Mapping[str, str] | None = None) -> str | None:
    """Translate a model's label into our entity vocabulary; unknown labels are dropped.

    ``label_map`` must match the model actually being served. See Part 5b.2 of
    PII_CODEC_ARCHITECTURE.md for why a mismatch is silent rather than loud.
    """
    return (label_map if label_map is not None else PIIRANHA_LABEL_MAP).get(normalize_label(raw_label))
