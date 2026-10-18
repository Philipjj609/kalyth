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

## 2026-10-18: keyed spike (KAL-20261018-020)

Three calls through Kalyth's gateway on the public FastAPI template, under a 0.25 USD cap:
0.0655 USD in all, at catalogue prices, which are still to be checked against the console.

- **Models endpoint.** The key listed 28 models. All three catalogue ids (Super, Ultra, Nano)
  were listed exactly. Newer NVIDIA entries also appeared: `nvidia/Nemotron-3_5-Lightning` and
  `nvidia/Nemotron-3.5-Super-VL`.
- **Super, summary, reasoning off** (`chat_template_kwargs.enable_thinking: false`). One call:
  6,897 input and 481 output tokens, 3.6 s. The answer was plain JSON with no reasoning text, so
  the switch appears to work.
- **Ultra, alternatives, reasoning on, 8,000 output tokens.** The first answer stopped at the
  limit (`finish_reason: length`) partway through indented JSON listing 14 direct changes for one
  alternative. The corrective retry succeeded: 12,923 input, 5,804 output tokens, 13.5 s. The
  limits are now 12,000 output tokens and at most 8 direct changes per alternative, and the prompt
  asks for compact JSON.
- **Quotes in citations.** Both models often rewrote quotes from Python source, replacing double
  quotes with single quotes (probably to avoid escaping inside JSON) and joining wrapped lines. Of
  54 citations, 7 matched their excerpt exactly; with the quote style normalised, 30 would have
  matched, and 40 if whitespace were ignored as well. The prompt now says to copy quotes exactly,
  escaping double quotes. Normalising quote style in the validator is proposed for review, not
  changed.

