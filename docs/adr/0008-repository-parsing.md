# 0008. Repository parsing with tree-sitter

Date: 2026-10-16. Status: accepted, based on the local parser spike of the same date.

## Context

The analyzer extracts observed facts (modules, imports, routes, data models) from repositories
without executing them. The pinned demo repository (fastapi/full-stack-fastapi-template at
b1125d8839482cb7bbae603ddc6d0081bf87532e) uses Python 3.14 syntax (PEP 758) that older parsers
reject. The fallback was a Python `ast` worker.

Spike results: web-tree-sitter 0.27.1 (WASM, MIT) loads the grammars shipped in tree-sitter-python
0.25.0 and tree-sitter-typescript 0.23.2 on Node 24 and Windows. All 152 tracked .py, .ts and .tsx
files parse with no error nodes in about 55 ms, including the PEP 758 clause. A prototype extractor
agreed with Python 3.14's own `ast` on all 191 import statements, all 23 FastAPI routes and both
SQLModel tables. Injected syntax errors stayed local to one node.

## Decision

Use tree-sitter only. No Python worker for now.

## Consequences

The Python grammar is permissive (it also accepts some invalid code) and lags some new syntax
(PEP 696 defaults). Error and missing nodes are recorded as partial-extraction limits in the
observation's coverage, never hidden. Python's `ast` may return later as an optional validator.
Positions from web-tree-sitter are UTF-16 based; evidence uses line numbers.
