# Hackathon submission: Kalyth

The text for the Devpost submission to the Nebius x NVIDIA Global AI Hackathon (October 2026),
kept with the code so it describes the release it submits, [v0.1.0](../releases/v0.1.0.md).

## Project

- **Name:** Kalyth
- **Tagline:** An evidence-backed engineering model of your codebase that people and coding agents
  share: grounded alternatives, decisions by people, verified hand-offs.
- **Track:** Coding and developer tools.
- **Repository:** https://github.com/Philipjj609/kalyth (Apache-2.0)
- **Live demo:** https://kalyth-demo.fly.dev/ (no sign-up; each visitor gets a private copy)
- **Video:** linked on the Devpost page (under three minutes).
- **Built with:** TypeScript, Node.js, React, Fastify, SQLite, tree-sitter, Model Context Protocol,
  NVIDIA Nemotron 3 Ultra, NVIDIA Nemotron 3 Super, Nebius Token Factory, Fly.io, Claude Code.

## About the project

### Inspiration

Coding agents are good at writing code and poor at knowing what a change touches, which design was
chosen and why, or whether what they did matches the decision. That knowledge lives in people's
heads and scattered documents, and it goes stale. I wanted one model of the system that people
and agents read and change together, where every claim says where it came from.

### What it does

Kalyth analyses a repository statically into a typed model: components, endpoints, data entities,
their relations, each fact pinned to the lines of source it was read from. When you ask for a
change, NVIDIA Nemotron proposes two to four alternatives, the elements each one changes, and the
questions that decide between them. Every citation is checked against the pinned source, and
Kalyth computes the propagated impact itself. A person compares the alternatives and decides.
Kalyth then compiles a deterministic context package for the accepted decision and hands it to a
coding agent over MCP. Claude Code claims the task, makes the change, commits it and reports. Kalyth
verifies the report against git, and reconciles the commit with the decision, so the model learns
what changed.

### How I built it

I built Kalyth as an individual developer, with extensive AI assistance: Claude Code wrote most of
the implementation, and other AI tools, ChatGPT among them, helped with research, architecture,
testing and review. I set the direction and made the product, spending and release decisions.

A TypeScript monorepo: a semantic kernel with immutable revisions and a replayable event log on
SQLite; a tree-sitter analyser; a provider gateway; the Navigator; a context compiler; task leases
and git verification; an HTTP and MCP server; and a React workbench.

Every model call goes through **Nebius Token Factory's OpenAI-compatible API** and one gateway.
**Nemotron 3 Ultra** proposes alternatives; **Nemotron 3 Super** writes element summaries and
answers the hosted demo's live requests, reasoning within a budget. Each call asks for structured
output against a strict JSON schema, needs the project's consent, and has its worst-case cost
reserved in a spend ledger before it runs. Answers that cite text not in the source are dropped,
never repaired.

The hosted demo runs on Fly.io: each visitor gets a private copy of the analysed FastAPI
full-stack template. Four change requests replay Nemotron Ultra answers recorded on Nebius, free
and instant, and a small daily allowance pays for live runs on Super.

### Challenges I ran into

- **Grounding.** Models swapped quote styles and joined lines when citing code. A prompt fix and a
  bounded, audited normalisation brought exact matches up without accepting invented quotes.
- **Spend under tiny budgets.** Reserving the worst case before each call keeps spend bounded, but
  Ultra's worst case did not fit the demo's daily allowance. I measured three configurations of
  Super and chose bounded reasoning with one attempt: about 30 seconds and 0.01 USD a run.
- **A real agent hand-off on camera.** Recording Claude Code unattended meant tightening its
  permissions, and two runs stopped at the commit before the final take.

### Accomplishments that I'm proud of

- A kernel where nothing changes without a revision, and the event log reproduces the state.
- A real, verified hand-off from a person's decision to Claude Code and back into the model.
- Grounded output: every kept claim cites source that still matches its pinned hash.
- A hosted demo that is safe to leave open: private copies, capped spend, no agent access, and
  accessibility checks on every main flow.

### What I learned

Grounding and spend control belong in the platform, not in the prompt. Agents become far more
useful when they get a decision with its constraints and open questions, rather than a pile of
files.

### What's next

An independent, blinded evaluation of whether Kalyth's context makes agents more complete and
correct, with its ground truth already frozen. Beyond that, an extensible engineering knowledge
fabric, reusable engineering methods, and multi-agent orchestration over the same model.

## Testing instructions for judges

1. Open https://kalyth-demo.fly.dev/ in a desktop browser (a phone works too). No sign-up is needed;
   you get your own copy, which others cannot see.
2. On the first page, choose **Try a recorded change request**, then **Add multi-tenancy**. It
   replays a real Nemotron 3 Ultra answer, free and at once, and opens its change thread.
3. Follow **Next step**: commit the alternatives, compare them side by side, answer a question, and
   accept one with a reason. Then compile the context package a coding agent would get.
4. To try a live run on Nemotron 3 Super, write your own request in **New change**. Live runs are
   limited per visitor and per day; the banner says how many you have left.
5. **Judge code:** [entered privately in Devpost's testing instructions]. Choose **I have a judge
   code** in the banner to use the judges' own allowance of live runs.

Agent access over MCP is off in the hosted demo. The README explains how to run Kalyth locally and
connect Claude Code or Codex; the video shows a real hand-off.

## Feedback on Nebius Token Factory and NVIDIA models

From the project's [feedback log](../feedback/nebius-nvidia.md):

- The OpenAI-compatible API and structured outputs worked without an SDK; I found two typos in
  the JSON-mode example.
- Nemotron citations often swapped Python's quote styles or joined lines; asking for exact copies
  helped but did not remove it.
- There is no documented spend cap per key or project, so Kalyth keeps its own spend ledger. A token-counting
  endpoint or a per-call price ceiling would let small deployments reserve less.
- Super with reasoning on sometimes spent its whole output budget thinking. Token Factory accepted
  `reasoning_budget`, which I found in no Nebius documentation; documenting it, and whether it is
  enforced, would help.
- Reasoning returned separately in `reasoning_content`, with reasoning tokens counted in `usage`,
  which made it easy to measure.
