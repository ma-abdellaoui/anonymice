"""A model's labels are not interchangeable, and a mismatch fails silently."""

import pytest

from litellm.pii.detection.ner_labels import (
    LABEL_MAPS,
    PIIRANHA_LABEL_MAP,
    PRIVACY_FILTER_LABEL_MAP,
    label_map_by_name,
    map_label,
    normalize_label,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("B-CITY", "CITY"), ("I-CITY", "CITY"), ("E-private_person", "private_person"), ("S-secret", "secret")],
)
def test_span_prefixes_are_stripped(raw: str, expected: str) -> None:
    """BIOES, not just BIO: E- and S- come from constrained span decoding."""
    assert normalize_label(raw) == expected


def test_a_hyphenated_label_is_not_mistaken_for_a_prefix() -> None:
    assert normalize_label("private_person") == "private_person"
    assert normalize_label("X-CITY") == "X-CITY"


def test_each_model_uses_its_own_vocabulary() -> None:
    assert map_label("SURNAME", PIIRANHA_LABEL_MAP) == "PERSON"
    assert map_label("private_person", PRIVACY_FILTER_LABEL_MAP) == "PERSON"


def test_the_wrong_vocabulary_detects_nothing() -> None:
    """The failure this module exists to make visible."""
    assert map_label("private_person", PIIRANHA_LABEL_MAP) is None
    assert map_label("SURNAME", PRIVACY_FILTER_LABEL_MAP) is None


def test_privacy_filter_bioes_labels_resolve() -> None:
    for prefix in ("B", "I", "E", "S"):
        assert map_label(f"{prefix}-private_email", PRIVACY_FILTER_LABEL_MAP) == "EMAIL_ADDRESS"


def test_every_privacy_filter_category_is_mapped() -> None:
    """All eight, so a category cannot be dropped by omission."""
    categories = {
        "account_number",
        "private_address",
        "private_date",
        "private_email",
        "private_person",
        "private_phone",
        "private_url",
        "secret",
    }
    assert set(PRIVACY_FILTER_LABEL_MAP) == categories


def test_an_account_number_is_not_labelled_as_a_us_one() -> None:
    """A US label attracts US policy, and US_SSN is configured to mask irreversibly."""
    assert PRIVACY_FILTER_LABEL_MAP["account_number"] == "ACCOUNT_NUMBER"
    assert not PRIVACY_FILTER_LABEL_MAP["account_number"].startswith("US_")


def test_an_unknown_map_name_falls_back_rather_than_disabling_detection() -> None:
    assert label_map_by_name("no-such-model") == PIIRANHA_LABEL_MAP
    assert label_map_by_name(None) == PIIRANHA_LABEL_MAP


def test_named_maps_resolve() -> None:
    assert label_map_by_name("privacy_filter") is PRIVACY_FILTER_LABEL_MAP
    assert set(LABEL_MAPS) == {"piiranha", "privacy_filter"}
