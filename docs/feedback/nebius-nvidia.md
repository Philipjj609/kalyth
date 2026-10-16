# Feedback log: Nebius Token Factory and NVIDIA models

The hackathon submission asks for feedback on these tools. This log records what we hit while
building Kalyth, with dates. It records only what we checked; it is not a review.

## 2026-10-16

- **Spend control.** Token Factory documents prepaid billing, but we found no documented hard spend
  cap. Kalyth therefore enforces its own cap in a local ledger before every call
  (ADR 0010). A per-key or per-project spend limit on the platform would remove the need.
- **Reasoning switch.** The documentation index has no page on turning reasoning on or off for
  reasoning models such as Nemotron 3. We assume `chat_template_kwargs.enable_thinking` and will
  confirm it in the keyed spike.
- **Structured output docs.** The JSON mode page explains `response_format` with `json_schema`
  clearly, and recommends also putting the schema in the prompt. Its `json_schema` cURL example
  spells the key `"response format"` (with a space), and the `"type"` line lacks a trailing comma.
  The JSON object example spells it correctly.
- **Model catalogue.** The model and pricing pages render client-side, so they could not be read
  without a browser. Model ids and prices came from third-party catalogues until a keyed call to
  the models endpoint can confirm them.
- **OpenAI compatibility.** The base URL and the OpenAI-compatible chat completions API are clearly
  documented, so the adapter needed no SDK.
