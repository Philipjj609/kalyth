# 0017. Bounded citation normalisation

Date: 2026-10-19. Status: accepted (ChatGPT's design review KAL-20261018-023, approved by Philip).
Amends ADR 0010.

## Context

The keyed Nebius spike (KAL-20261018-021, -022) found that Nemotron often rewrites quotes from
Python code: it replaces double quotes with single quotes, probably to avoid escaping inside JSON,
and joins wrapped lines. The grounding validator rejected those citations, and with them the
statements and direct changes they supported. A prompt fix raised the exact rate in the re-run to
7 of 12 (summary) and 30 of 40 (alternatives); every remaining rejection was quote form or layout
alone.

## Decision

The validator keeps two passes, and reports them separately.

**1. Exact (unchanged).** The quote occurs in the cited excerpt, with runs of whitespace counted as
one space; this also absorbs CRLF and LF. This is the benchmark metric, reported as "exact", and
nothing is ever relabelled as exact.

**2. Bounded normalisation, only when the exact pass fails.** The quote and the excerpt are read as
code tokens:

- runs of letters, digits and underscores;
- every other non-space character on its own.

The tokens must match one for one. Identifiers, numbers, operators, punctuation and ASCII quote
characters are never removed, merged or changed, so `return x` never matches `returnx`, and `==`
never matches `!=`. Forgiven:

- **layout:** whitespace or line breaks between tokens;
- **typographic quotes:** read as their ASCII form.

The match must be unique in the excerpt; a quote that matches two places is rejected as ambiguous.

**ASCII single and double quotes are not equivalent.** Quote style can change meaning in code, so
by default a swapped delimiter is a rejection. One narrow fallback is available, off unless
`KALYTH_GROUNDING_PYTHON_STRINGS=1`: in `.py` and `.pyi` files only, a string literal written with
the other delimiter counts as the same literal when its content has no quotes, backslashes or line
breaks. In Python such literals mean the same thing.

**Unchanged checks.** Each citation is still checked against everything else:

- the reference must have been in the model's context;
- the excerpt must still hash to its pinned span (checked again at validation, so a stale excerpt
  is rejected);
- the quote must have at least 12 non-space characters;
- a quote found only in another excerpt is rejected;
- an item with any rejected citation is rejected.

**Reporting.** The run's grounding report keeps three counts:

- `exactCitations`;
- `normalizedCitations`;
- rejected, which is `citations − validCitations`.

`validCitations` is exact plus normalised. Each normalised match is kept, up to 100 per run, with
the model's quote and the located source text, both verbatim, and what differed. Runs recorded
before this change have no separate counts; every accepted citation in them was exact. The UI shows
the three counts and lists the normalised matches.

**Meaning.** A normalised match establishes where the quoted text is. It does not establish that
the model's reading of that code is right.

## Evidence

The recorded spike answers, replayed with `pnpm spike:replay` (no calls), as exact / normalised /
rejected:

| Answer | Bounded rules | With the Python fallback |
|---|---|---|
| Run 1 summary (11) | 3 / 0 / 8 | 3 / 7 / 1 |
| Run 1 alternatives (43) | 4 / 3 / 36 | 4 / 26 / 13 |
| Re-run summary (12) | 7 / 0 / 5 | 7 / 5 / 0 |
| Re-run alternatives (40) | 30 / 0 / 10 | 30 / 10 / 0 |

All 48 normalised matches differ from their source only in Python string delimiters, layout or
both. None differs in any code token, so none is a false acceptance. The one remaining rejection
in run 1's summary cites the wrong excerpt, and is still rejected.

Adversarial tests cover:

- a changed operator, identifier, number or string literal, and a merged token;
- a quote from another excerpt or path;
- a stale excerpt;
- a normalised match found twice;
- a short quote;
- the fallback on a non-Python file, and on literals with quotes or backslashes.

## Alternatives

- **Treat ASCII quotes as equivalent everywhere.** Rejected: in many languages, and in shell,
  quote style changes meaning.
- **Ignore all whitespace in a character comparison.** Rejected: it merges tokens, so `returnx`
  would match `return x`.
- **Citations by evidence span instead of quoted text.** Proposed separately in ADR 0018.

## Consequences

- With the bounded rules alone, little changes on this sample. The gain comes from the Python
  fallback, which is opt-in.
- Philip turned the fallback on for the hosted demo only (KAL-20261019-032, ADR 0019); local mode
  keeps it off unless a person sets it.
- Benchmark reports keep quoting the exact rate, with normalised acceptances beside it.
