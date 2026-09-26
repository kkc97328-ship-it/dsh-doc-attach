# Notes for agents working in this repository

## Before you start

开发任何 Harness 插件前，可以先阅读 `docs/internal/dsh-doc-attach-dev-notes.md`，并按照其中的检查清单执行。

That file holds the accumulated development notes for this plugin: the Cordis
composition rules, the OOXML/OLE2 extraction pitfalls, the sandbox constraints,
and the verification checklist. It is deliberately **not published** — it lives
in `docs/internal/`, which is listed in `.gitignore`, so it exists only in a
local working copy.

If the file is missing (for example, you cloned this repository fresh), the
published `README.md` still describes the user-facing behaviour, and the test
suites under `tests/` still encode the contracts.

## Quick orientation

| Path | What it is |
| --- | --- |
| `cordis.patch.yml` | The three plugin rows this package contributes |
| `lib/client.js` | Browser half: the drop/paste dock in the composer |
| `plugins/read-document.mjs` | The `document_outline` / `document_search` / `document_read` tools |
| `plugins/drop-ingest.mjs` | HTTP route that ingests a dropped file into the workspace |
| `lib/extract/` | Zero-dependency extractors (Python stdlib + hand-written OLE2 parsers) |
| `tests/run-all.mjs` | Test entry point; `--portable` runs the subset with no machine-specific fixtures |

## Verifying a change

```powershell
node tests/run-all.mjs --portable
```
