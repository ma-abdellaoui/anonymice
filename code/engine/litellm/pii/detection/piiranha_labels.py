from types import MappingProxyType
from typing import Final

ID_CARD_NUMBER: Final = "ID_CARD_NUMBER"
PASSWORD: Final = "PASSWORD"
TAX_NUMBER: Final = "TAX_NUMBER"
USERNAME: Final = "USERNAME"

EXTENDED_ENTITY_TYPES: Final[frozenset[str]] = frozenset((ID_CARD_NUMBER, PASSWORD, TAX_NUMBER, USERNAME))
BIO_PREFIXES: Final[frozenset[str]] = frozenset(("B", "I"))

PIIRANHA_LABEL_MAP: Final[MappingProxyType[str, str]] = MappingProxyType(
    {
        "ACCOUNTNUM": "US_BANK_NUMBER",
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

NER_ONLY_ENTITIES: Final[frozenset[str]] = frozenset(PIIRANHA_LABEL_MAP.values())


def normalize_label(raw_label: str) -> str:
    """Strip the BIO prefix that non-aggregated pipelines emit (``B-CITY`` -> ``CITY``)."""
    head, separator, tail = raw_label.partition("-")
    return tail if separator and head in BIO_PREFIXES else raw_label


def map_label(raw_label: str) -> str | None:
    """Translate a Piiranha label to our entity vocabulary; unknown labels are dropped.

    This map is Piiranha's vocabulary, not a general one. A model emitting the
    standard CoNLL labels (PER, LOC, ORG) maps to nothing here, so it would
    detect PII and report none of it without raising. Give another model its own
    map before pointing LITELLM_PII_NER_API_BASE at it. See Part 5b.2 of
    PII_CODEC_ARCHITECTURE.md.
    """
    return PIIRANHA_LABEL_MAP.get(normalize_label(raw_label))
