# Hosted demo data

The hosted demo ([ADR 0019](../../docs/adr/0019-hosted-demo.md)) starts every visitor from a copy
of one template project.

- `template.json` is a project export (`pnpm project:export`, ADR 0014) of a clean
  `pnpm demo:setup` build. It holds the analysis of
  [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template) at
  tag 0.12.0, including short source excerpts as evidence. That project is MIT-licensed, copyright
  Sebastián Ramírez. The demo server imports this file at startup. Import keeps its ids, so
  recordings made against it keep matching.
- `recordings/` holds the preset runs' recorded Nemotron answers (`recordings.json`: the
  responses and a hash of each request, never a prompt or key), and `presets.json`, listing which
  presets were recorded. They were made once, on 19 October 2026, with `pnpm demo:record` against
  Nebius Token Factory. That was approved in KAL-20261019-030 and cost 0.058 USD, under a separate
  ledger capped at 0.30 USD. The demo replays them at no cost.

To rebuild the template after an analyser change:

```bash
pnpm demo:setup --force
pnpm project:export --project <project id> --out deploy/demo/template.json
```

Then record the presets again, because the new ids no longer match the old recordings.

The secret scan in CI reads each recording's `"key"`, the SHA-256 of a request, as a possible API
key. After a new recording, check the findings are only those hashes and list their fingerprints
in `.gitleaksignore` with the reason.
