# Seed knowledge libraries

`real-time-networking.json` is the first Kalyth knowledge library (K1 of
[the knowledge-fabric design](../../docs/design/knowledge-fabric.md)). It holds the operations of
one proposal, to file in a project of kind `library`: 16 cited passages, 21 objects (10 concepts,
1 principle, 7 patterns, 2 conditions, 1 open question) and 23 relations about networking
real-time multiplayer games.

## Where it comes from

Claude drafted it as a research agent on 30 October 2026, from eight public articles by Gabriel
Gambetta, Glenn Fiedler, and Mark Terrano and Paul Bettner. Each page was fetched that day to
confirm its title and the section cited. The Valve developer wiki articles were left out: their
pages sit behind a bot check.

## What it does not claim

- Every item is `proposed`. Nothing is reviewed or verified, so nothing can be `established`
  until a curator does both (ADR 0026 I3).
- Every citation is a paraphrase with a section locator. No text of the articles is stored
  (`quotePolicy: "none"`).
- Every licence is `unknown`, because an agent may not confirm one (ADR 0030 A2). A curator
  confirms it with `verifySource`.
- The gamedeveloper.com page's byline names only Paul Bettner. The paper is usually credited to
  Mark Terrano and Paul Bettner, so both are listed; verifying that source should check this.
- The principle "do not trust the client" has no exceptions, because its source gives none. An
  open Question asks where it does not apply.

## Curating it

A person with `knowledge.curate` on the library, acting directly, reviews each support group
(`reviewSupport`), verifies each source and confirms its licence (`verifySource`), and then may
set items to `established` (`setMaturity`). `packages/core/test/seed-library.test.ts` checks that
the file is a valid agent proposal and that it claims nothing beyond that.
