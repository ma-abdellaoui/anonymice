"""Write a recognizer registry config with an extra language registered.

Reads the registry Presidio ships and writes a patched copy, rather than
editing the vendored file in place: the copy is what RECOGNIZER_REGISTRY_CONF_FILE
points at, so the change is visible in one named file instead of as a silent
mutation of a package under site-packages.

Recognizers with no explicit ``supported_languages`` are instantiated once per
language in the top-level list. That is what carries EMAIL_ADDRESS, IBAN_CODE,
PHONE_NUMBER, URL, IP_ADDRESS and CRYPTO into the added language. Recognizers
pinned to a single language, such as the US and UK ones, are left alone.
"""

import sys
from pathlib import Path

import yaml

SHIPPED = Path("/usr/bin/presidio_analyzer/conf/default_recognizers.yaml")


def main(language: str, destination: str) -> None:
    loaded = yaml.safe_load(SHIPPED.read_text())
    languages = list(loaded.get("supported_languages") or ["en"])
    if language not in languages:
        languages.append(language)
    loaded["supported_languages"] = languages
    Path(destination).write_text(yaml.safe_dump(loaded, sort_keys=False, allow_unicode=True))
    print(f"registered languages: {languages}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
