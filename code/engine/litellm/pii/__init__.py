"""Reversible PII anonymization: detection, encoding, and decoding.

Provider-agnostic core. Nothing here imports from ``litellm.proxy`` so the
package stays usable from the guardrail hook, the REST endpoints, and tests
alike.
"""
