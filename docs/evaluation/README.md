# Evaluation ground truth (gate G6)

The evaluation asks whether a coding agent finds the right files to change more reliably with a
Kalyth context package than with plain retrieval. It uses the same NVIDIA Nemotron model and token
budget in both conditions, on the pinned holdout repository. The ground truth is the set of
existing files a correct implementation of each change would modify.

[`ground-truth.draft.json`](ground-truth.draft.json) holds three scenarios on
`fastapi/full-stack-fastapi-template` at commit `b1125d8839482cb7bbae603ddc6d0081bf87532e`:

| Scenario | Change | Files |
|---|---|---|
| `multi-tenancy` | organisations with memberships; items scoped to an organisation | 26 |
| `rbac` | replace the `is_superuser` flag with role-based access control | 15 |
| `refresh-token-cookie` | replace the stored bearer JWT with refresh-token rotation in an httpOnly cookie | 15 |

## Independence

A research subagent drafted these lists in Phase 0 by reading and grepping the code, before Kalyth
existed. Since then, Claude, who implements Kalyth, has only expanded globs to file names, written
full paths, and checked that every file exists at the commit. No file was added or removed.

During development, Kalyth's mock pipeline was exercised with a multi-tenancy request. No real model
output exists for any scenario.

So that the truth is not tuned to Kalyth, a person other than the implementer reviews and freezes
it (decision D13): Philip or ChatGPT.

## Review

For each scenario, decide for each listed file whether a correct, complete implementation would
change it at the pinned commit. Remove files that would not change, and add files that would.
Regenerated API clients and tests count as changed files. New files are listed under `newFiles`
for context and are not scored. The `lines` notes are hints from the draft, not part of the truth.

## Freeze

1. Set `status` to `frozen`, fill in `reviewedBy` and `frozenAt`, and save the file as
   `ground-truth.json`.
2. Commit it and record its SHA-256 in the coordination queue.
3. Make any later change as a new, separately recorded version; never edit a frozen file in place.

Only after this does Kalyth run on these scenarios for the evaluation. The harness will refuse a
truth file whose hash does not match the recorded one.

## Measures

Taken from the Phase 0 review, section 11:

- impacted-file recall and precision against the frozen truth;
- coverage of constraints and contracts;
- unsupported claims: citations the grounding validator rejects, plus a manual spot check;
- staleness across the advance from 0.12.0 to the pinned commit;
- cost and latency.

Three runs per scenario and condition. Results are reported with their small sample size and without
claims of statistical significance.
