# WIS draft reference scope

This directory contains a published design draft, synthetic examples and offline tests, not a production runtime. Read README.md and CODEX_IMPLEMENTATION.md before using it as implementation input. Follow applicable repository guidance as well.

Keep pocket money (external purchasing authority) separate from energy (model tokens). Never invent real usage, authentication, signatures, payment or interoperability claims from schema validation.

Run `python docs/world-interface/v0.1/tests/validate.py` from the repository root for changes to this bundle. The test dependency is `jsonschema>=4.18,<5`. Record unrun checks honestly. Preserve the published v0.1 meaning; document corrections and version changes explicitly. Do not commit secrets, private runtime records, real payment credentials or personal conversation history.
