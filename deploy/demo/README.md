# Hosted demo data

The hosted demo ([ADR 0019](../../docs/adr/0019-hosted-demo.md)) starts every visitor from a copy
of one template project.

- `template.json` is a project export (`pnpm project:export`, ADR 0014) of a clean
  `pnpm demo:setup` build. It holds the analysis of
  [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template) at
  tag 0.12.0, including short source excerpts as evidence. That project is MIT-licensed, copyright
  Sebastián Ramírez. The demo server imports this file at startup. Import keeps its ids, so
  recordings made against it keep matching.
- `recordings/` will hold the preset runs' recorded Nemotron answers, made once with
  `pnpm demo:record` against Nebius, and `presets.json`, listing which presets were recorded.
  Recording costs money, so it waits for Philip's go-ahead (ADR 0019, amendments 1 and 5).

To rebuild the template after an analyser change:

```bash
pnpm demo:setup --force
pnpm project:export --project <project id> --out deploy/demo/template.json
```

Then record the presets again, because the new ids no longer match the old recordings.
