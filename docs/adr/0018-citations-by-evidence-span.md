# 0018. Citations by evidence span

Date: 2026-10-19. Status: proposed, not implemented. Needs a decision, and one measured trial run
once a development budget is approved.

## Context

Citations today carry the quoted text. The model must copy code character for character, and the
validator checks the copy (ADR 0010, ADR 0017). The spike showed that copying is where models
fail. Before the prompt fix, 7 of 54 citations were exact. After it, 37 of 52 were exact, and the
rest failed only on quote form or layout. Every one of those failures is a transcription error,
not a sourcing error.

The recorded answers suggest that the model could instead point at lines:

- excerpts average 13 lines;
- 60 of the 92 citations accepted in the replay sit on a single source line.

## Proposal

A citation names the evidence handle and a line range, plus a short anchor:

```json
{ "ref": "E3", "lines": "56", "anchor": "owner_id" }
```

- **Context.** Every excerpt line is shown with its file line number, as in `56| if not ...`, in
  the line range the evidence already records. The prompt grows by about 5 characters a line.
- **Validation.**
  - The reference must have been in the context, and the excerpt must hash to its pinned span.
  - The range must lie within the evidence span and cover at most 5 lines.
  - The anchor (one code token of at least 4 characters, or a short phrase) must occur exactly in
    those lines. It catches off-by-one and wrong-line citations.
  - The cited text is those lines, taken verbatim from the pinned excerpt, and kept in the run
    report for audit. Nothing is ever transcribed, so formatting cannot fail.
- **Optional hybrid.** The model also gives a short quote, which must occur, exactly or with
  bounded normalisation, inside the cited lines. That is a stronger link to the text than an
  anchor, and the search is limited to a few lines.
- **Kernel.** Unchanged at first: claims still cite the whole evidence record. Later, a citation
  could become its own evidence record for the cited lines, with their own hash, so provenance
  points at the exact lines. That is a separate change to the evidence model.

## Tradeoffs

- **Gains:**
  - no transcription failures;
  - a smaller and more predictable output (no long quotes);
  - the source text in the audit is always verbatim.
- **Risks:**
  - The model must get line numbers right. The anchor detects mistakes but does not fix them.
  - A line range plus an anchor is weaker evidence of reading than a full quote. The hybrid
    restores most of that.
  - Ranges could be padded to be safe, which the 5-line limit stops.
- **Effort:** about half a day: the citation schema (a union of quote and span), the numbered
  context, the validator, the mock responder, tests and the report view.

## Measurement plan (no spend now)

1. Build it behind a flag, exercised with the mock responder only.
2. With an approved budget, run the spike once in each format on the same inputs: one summary on
   Super and one alternatives call on Ultra, about 0.03 USD.
3. Compare per format:
   - exact or accepted rate;
   - rejected rate, by reason;
   - output tokens;
   - for 20 citations, whether the cited lines actually support the statement, checked by a
     person.
4. Adopt span citations only if the accepted rate rises with no drop in support quality.
