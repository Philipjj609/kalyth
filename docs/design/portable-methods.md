# Portable methods: skills and method packages for external agents

Date: 2026-10-30. Status: design note, for review. Nothing here is built yet; no generator exists.

## Why

Kalyth's engineering knowledge should be usable where engineering happens: in Kalyth's own UI,
through MCP, the HTTP API and a CLI, and inside coding agents such as Claude Code and Codex. The
last of these needs a portable form, because agents load skills from files they can read offline.

One rule decides the design: **the authority stays in Kalyth.** Knowledge, methods, evidence and
applicability are versioned in Kalyth's semantic store, with review and provenance (ADRs 0026 to
0030). A downloadable skill is a portable, version-pinned expression of a reviewed method, never
a second source of truth. An agent that needs current knowledge or project context asks Kalyth
through MCP instead of trusting an old copy.

## Three ways in

| Surface | What it gives | Current or pinned |
|---|---|---|
| Kalyth UI | Curation, review, assessments, decisions | current |
| MCP, HTTP API, CLI | Queries for knowledge, pins, applicability and project context; proposals | current, at a revision the caller names |
| Portable package | A method's steps, checks and the knowledge it uses, for an agent to follow | pinned to one library revision |

A package says, in its first lines, that it is a pinned copy, which revision it reflects, and how
to ask Kalyth for the current state when an MCP connection exists.

## What a package is

A **method package** is generated from one `knowledge.Method` (ADR 0029) at one library revision:

- **scope:** the method's `purpose` and `appliesTo` (element types, whether it needs scenarios),
  and the conditions under which its patterns apply, stated as Kalyth states them ("conditions
  met", never "recommended", ADR 0028 I8);
- **content:** steps, the check catalogue entries it uses, and the concepts, principles and
  patterns it relies on, each as a pin `(library, id, revision, versionSha256)`;
- **provenance:** library id and label, revision, generation time, the generator's version, and
  for every item its maturity, dispute status and sources with their attribution and licences;
- **limitations:** what the method does not cover, items still `proposed` or `hypothesis`,
  disputed items, and the questions left open, carried over rather than summarised away;
- **a manifest** with the hashes of every file, so a harness or a person can check that nothing
  was changed after generation.

Only **reviewed** methods are packaged: a method and the knowledge it relies on must be at least
`proposed` with every source verified, and hypotheses are labelled as such inside the package
(check `hypotheses-labelled`). Whether packaging should need `established` is an open question.

Licences limit what a package may carry. A source with `quotePolicy: "none"` contributes its
locator and attribution, never text; an `unknown` licence blocks quotes entirely.

## Supported harnesses

One package format, with thin adapters per harness, generated from the same manifest:

- **Claude Code:** a skill folder (`SKILL.md` plus references), installable on its own or inside
  a plugin, with an optional MCP server entry that points at a Kalyth instance;
- **Codex:** the same skill content in the layout Codex loads, plus an `AGENTS.md` fragment that
  says when to use it;
- **generic:** plain `SKILL.md` and Markdown references for agents without a plugin system.

Adapters change layout and wording of the entry point only, never the method's content.

## Update semantics

- A package never updates itself. Its pins stay valid: the content it describes is exactly what
  the library said at that revision (ADR 0027 I2).
- With an MCP connection, the agent can ask whether the package is current: Kalyth compares the
  package's pins with the library head, as the pin status read model does for projects
  (`current`, `unchanged`, `changed`, `removed`), and says what changed.
- A new package is a new version, generated from a newer revision; its manifest names the one it
  replaces. Disputes or deprecations after generation are reported through MCP, not written into
  installed copies.
- Removing or replacing a package is the user's action in their harness.

## What I take from the references, and what I do not

I looked at two projects for distribution and interoperability, not as architectures to copy.

- **affaan-m/ECC**: one versioned package (`ecc-universal@2.2.3`) installed into many harnesses,
  each through its native mechanism (a Claude Code plugin, a Codex plugin, project-local adapters
  for others), with a warning against mixing install paths and a scanner for agent configuration.
  Worth taking: pinned versions, native adapters per harness, one install path at a time, and
  checking what gets installed. Not taken: shipping a large general catalogue of skills, agents and
  hooks. Kalyth packages only its reviewed methods.
- **HKUDS/CLI-Anything**: executable tool access for agents through CLIs with structured output,
  one canonical `skills/` directory with a `SKILL.md` per tool, and a registry that installs,
  updates and removes them. Worth taking: a canonical source directory for all generated skills,
  machine-readable command output, and a registry entry per package with its version. Not taken:
  wrapping arbitrary software; Kalyth's executable surface is its own CLI and MCP tools.

## Open questions

1. Must every item a package relies on be `established`, or is "proposed, verified, labelled"
   enough?
2. Should packages be signed, and by whom, before anyone else installs them?
3. Which CLI commands should exist first: knowledge queries, pin status and method selection?

## Not now

No generator, no packaging command, no registry, and no changes to MCP tools. This note is input
for the ADR that will define the package format, after K3 and K4 give methods something to apply.
