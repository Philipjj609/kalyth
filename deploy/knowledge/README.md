# Seed knowledge libraries

`real-time-networking.json` is the first Kalyth knowledge library (K1 of
[the knowledge-fabric design](../../docs/design/knowledge-fabric.md)). It holds the operations of
one proposal, to file in a project of kind `library`: 16 cited passages, 22 objects (10 concepts,
1 principle, 7 patterns, 2 conditions, 2 open questions) and 24 relations about networking
real-time multiplayer games.

## Where it comes from

Claude drafted it as a research agent on 30 October 2026, from eight public articles by Gabriel
Gambetta, Glenn Fiedler and Paul Bettner. Each page was fetched that day to
confirm its title and the section cited. The Valve developer wiki articles were left out: their
pages sit behind a bot check.

## What it does not claim

- Every item is `proposed`. Nothing is reviewed or verified, so nothing can be `established`
  until a curator does both (ADR 0026 I3).
- Every citation is a paraphrase with a section locator. No text of the articles is stored
  (`quotePolicy: "none"`).
- Every licence is `unknown`, because an agent may not confirm one (ADR 0030 A2). A curator
  confirms it with `verifySource`.
- Authors are recorded as each cited page credits them. The Age of Empires article's page
  credits only Paul Bettner (its byline, author data and "About the Author"), while its text
  describes work by a colleague called Mark, and the article is often cited as co-written with
  Mark Terrano. I could not confirm that from the page or a search, so only Paul Bettner is
  listed, and an open Question asks the curator to confirm the authors before verifying either
  citation of that article.
- The principle "do not trust the client" has no exceptions, because its source gives none. Its
  scope is the article's context, multiplayer games, and an open Question asks where it does not
  apply.
- No citation is a matched quotation. Verifying a source records that the page exists and that
  the section holds the passage relied on; it does not check any wording.

## Curating it

A person with `knowledge.curate` on the library, acting directly, reviews each support group
(`reviewSupport`), verifies each source and confirms its licence (`verifySource`), and then may
set items to `established` (`setMaturity`). `packages/core/test/seed-library.test.ts` checks that
the file is a valid agent proposal and that it claims nothing beyond that.
