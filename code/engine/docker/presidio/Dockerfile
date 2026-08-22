# Presidio analyzer with German registered alongside English.
#
# The stock image loads English only, so a request with language "de" is
# rejected with "No matching recognizers were found to serve the request" and
# the rules stage reports an outage. Every Swiss document in the corpus this
# proxy serves is German, so that is the default path, not an edge case.
FROM mcr.microsoft.com/presidio-analyzer:2.2.360

# The image's dependencies live in a Poetry virtualenv, not in the system
# interpreter, so a bare `python` here cannot import yaml or spacy.
WORKDIR /usr/bin

COPY nlp.yaml /opt/pii/nlp.yaml
COPY analyzer.yaml /opt/pii/analyzer.yaml
COPY add_language.py /opt/pii/add_language.py

# Weights at build time, not on first request: a language that downloads its
# model on demand turns the first German prompt into a timeout.
RUN poetry run python /usr/bin/install_nlp_models.py --conf_file /opt/pii/nlp.yaml

RUN poetry run python /opt/pii/add_language.py de /opt/pii/recognizers.yaml

# Fail the build rather than the first request if either file is unusable.
RUN poetry run python -c "\
from presidio_analyzer import AnalyzerEngineProvider; \
e = AnalyzerEngineProvider(analyzer_engine_conf_file='/opt/pii/analyzer.yaml', \
    nlp_engine_conf_file='/opt/pii/nlp.yaml', \
    recognizer_registry_conf_file='/opt/pii/recognizers.yaml').create_engine(); \
r = e.analyze(text='Kontakt: hans.mueller@example.ch, IBAN CH1489268027498210642', language='de', \
    entities=['EMAIL_ADDRESS','IBAN_CODE']); \
assert {x.entity_type for x in r} == {'EMAIL_ADDRESS','IBAN_CODE'}, r; \
print('de smoke test passed:', r)"

ENV ANALYZER_CONF_FILE=/opt/pii/analyzer.yaml
ENV NLP_CONF_FILE=/opt/pii/nlp.yaml
ENV RECOGNIZER_REGISTRY_CONF_FILE=/opt/pii/recognizers.yaml
