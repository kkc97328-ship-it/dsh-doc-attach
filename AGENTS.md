# Notes for agents working in this repository

## Before you start

开发任何 Harness 插件前，可以先阅读 `docs/dsh-doc-attach-dev-notes.md`，并按照其中的检查清单执行。

That file holds the accumulated development notes for this plugin: the Cordis
composition rules, the OOXML/OLE2 extraction pitfalls, the sandbox constraints,
and the verification checklist. It is published in **sanitized** form — local
absolute paths and machine details are replaced with placeholders, and it
contains no tokens, credentials or personal information.

The **unsanitized** original is kept out of git at
`docs/internal/dsh-doc-attach-dev-notes-original.md` (`docs/internal/` is listed
in `.gitignore`), so it exists only in a local working copy — never in a clone.

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
