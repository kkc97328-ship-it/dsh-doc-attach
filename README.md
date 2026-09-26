# dsh-doc-attach

Drag a PDF into the DeepSeek Harness composer and the agent can read it — and
answer questions from it with page citations.

Works in **every workspace and every session**, because both halves sit on
global planes (the tools registry and the browser plugin roster), not in an
agent preset.

## What it adds

**In the GUI** — drop a `.pdf` / `.docx` / `.pptx` onto the page, or paste one
with Ctrl+V. The file is uploaded to the host, written into the current
session's workspace under `.dsh-drops/`, and its path is appended to the
composer draft as an `@` reference. Images are deliberately left alone: pasting
a screenshot still goes to the existing image channel, not here.

**For the agent** — three retrieval tools, working on one unit concept: a
**block**. For a PDF a block is a page; for Word it is a paragraph, a heading,
or one table row; for a `.pptx` it is a slide; for a legacy `.ppt` it is one
text container. The tool text always says which.

| Tool | Purpose |
|---|---|
| `document_outline` | Scale (blocks), total characters, empty blocks, and the **outline** where one exists — Word heading levels, or a deck's slide titles — so the agent can see the structure before reading anything. |
| `document_search` | Keyword or regex search across the document, returning **block numbers, surrounding context, and the enclosing heading**. One row per block, with an occurrence count. |
| `document_read` | Read a window of blocks, annotated for citation; Word headings and table rows, and presentation slides, are marked as such. |

**Images are deliberately not handled here.** A dropped or pasted `.png` /
`.jpg` / `.jpeg` goes to the harness's own image channel, which previews it and
sends it as an image block. Intercepting images would store a picture as a
document instead of showing it, so every allow-list in this plugin excludes
them — and `tests/test-extension-consistency.mjs` fails if one is ever added.

The point is the workflow, not the file dump: a 53-page paper, or a 267-block
Word document, is never pushed into the context whole. The agent outlines,
locates, reads the located passage, and answers with citations. This plugin does
not summarise or interpret anything — understanding and organising the answer is
the model's job.

## Why it is built this way

**Document extraction is a subprocess.** This deployment has no reachable module
registry and no JS document parser, so the backend bridges to a local Python:
PyPDF2 for PDF, and the standard library's `zipfile` for Word (which is why no
python-docx is needed). It is kept behind a small method surface so a pure-JS
backend can replace it later.

**Word heading detection resolves style ids through `styles.xml`.** A
`w:pStyle` value is a style ID, not a name. Documents produced by WPS and
several other exporters use bare numeric ids (`val="2"`) whose meaning lives
only in `styles.xml` (`name="heading 1"`), so matching the id against a heading
pattern finds nothing and the outline comes back empty. The fixture in
`tests/make-docx-fixture.py` reproduces exactly that shape as a regression
guard.

**The block cache is versioned.** The cache key covers path, size, mtime *and*
an extractor version, so a result produced by an older extractor can never be
served as if it came from the current one.

**The result travels through a file, not stdout.** Under the confined sandbox a
child process cannot open named pipes, so `execFile`/`spawn` with piped stdio
fails with `spawn EPERM`. Spawning with `stdio: 'ignore'` and reading an `--out`
file is the permitted mode. Verify with `_probe/spawn-stdio-probe.mjs` in the
development copy.

**Upload goes over an HTTP route, not harness RPC.** Exposing a host method to
the browser normally needs the Typert `@Remote` generated contract, and the set
of mountable remotes is fixed at build time by the shipped `dsh-web-app`
bundle — a third-party plugin cannot add one. `ctx.webServer.register` is the
general route registry the harness itself uses for every feature route.

**Security posture of the upload route.** The server has no auth and is
loopback-only by default, so the endpoint must not be an arbitrary file-write
primitive. The destination must be a workspace the *host* has registered; the
browser only ever sends its session id, and the host derives the directory from
its own registry. File names are reduced to a basename, extensions are
allow-listed, and the body is capped before decoding.

**Legacy `.doc` is parsed in-process, not converted.** `.doc` is OLE2/CFB, not
OOXML, and every external route is closed on the target machine: `antiword`,
`catdoc`, `wvText`, LibreOffice and `wordconv` are absent, pandoc cannot read
the binary format, every Python `.doc` library is missing, the module registry is
unreachable, and **Word COM automation hangs** — the host process has no
interactive desktop, so `Word.Application` never returns (measured: killed after
240 s, having left a stray WINWORD that had to be reaped). `lib/extract/doc_reader.py`
therefore parses the container itself: CFB sector/FAT/DIFAT chains, the FIB, and
the piece table, decoding both UTF-16 and 8-bit code-page pieces.

**Known limitations**

- Web GUI only. The Electron desktop app loads over `file://` and routes fetch
  through an IPC bridge instead of this server, so the upload route is
  unreachable there.
- Text-layer documents only. A scanned PDF has no text layer; the tools say so
  explicitly rather than returning empty content. No OCR.
- PDF, `.docx`, `.doc`, `.pptx` and `.ppt` are all readable. `.pptx` is verified
  against real 2.1–2.7 MB decks; `.ppt` against a real 620 KB deck plus the
  Office-shipped templates.
- Word block numbering follows paragraph/table-row order, not printed pages: a
  Word file has no fixed pagination without a renderer.
- **No heading outline for `.doc`.** Detecting headings in a legacy document
  needs the style sheet (STSHF) rather than `styles.xml`, which is not parsed
  yet; `.docx` headings do work.
- **A legacy `.ppt` reports no slide numbers.** Mapping a text container back to
  a real slide needs the drawing tree correlated with the slide-persist records,
  which this reader does not do, so its unit is deliberately a block. Numbering
  containers as "slide N" would report an internal counter as the slide a user
  sees.
- **A legacy `.ppt` can include slide-master wording** (for example "Click to
  edit Master title style"), because the master's drawing reaches the same
  record type as slide drawings. Producer-internal labels (`___PPT<n>`,
  `Equation.<n>`) and placeholder-only blocks are filtered; master prose is not.
- **The `.doc` 8-bit "compressed" piece branch has no end-to-end fixture.**
  Every real `.doc` available on the target machine stores UTF-16 pieces —
  Chinese documents cannot produce compressed pieces — and a synthetic `.doc`
  cannot be generated there because Word COM hangs. The branch is implemented
  and unit-reachable, but not covered by a real document.
- PDF reading depends on a local Python with PyPDF2; Word and PowerPoint reading
  need only the standard library. Set `DSH_DOC_PYTHON` (or the row's
  `pythonPath`) to point at a suitable interpreter.

## Install

```powershell
pwsh -File install.ps1 -DryRun   # report only
pwsh -File install.ps1           # place the package, register the bundle
```

Then **restart the host**: client package metadata is cached per name and never
expires, so the browser half appears only after a restart.

Verify:

```
GET http://127.0.0.1:3080/api/doc-attach/health   -> {"ok":true,...}
```

Rollback: restore the newest `package.json.bak-*` in the profile and delete
`node_modules/dsh-doc-attach`.

## Tests

```bash
node tests/run-all.mjs
```

Eight suites (109 checks), all offline and self-contained:

| Suite | Covers |
|---|---|
| `test-composition.mjs` | The client-packaging contract: a bare-package-name row exists, `exports["."]` and `exports["./client"]` resolve, the bundle registers under the package id — plus live checks against an installed profile copy. |
| `test-extension-consistency.mjs` | The four extension allow-lists agree, and images are deliberately absent from all of them. |
| `test-document-backend.mjs` | stats / search / extract, the block cache, and every failure mode, against real PDFs **and** a generated Word fixture. Includes the numeric-style-id heading regression guard. |
| `test-doc-format.mjs` | Legacy `.doc`: format, blocks, search, and refusals, against a real `.doc`. |
| `test-ppt-format.mjs` | `.pptx` slide ordering, outlines and notes against a generated deck, plus legacy `.ppt`. |
| `test-document-tools.mjs` | Tool schemas, registration, and the **document-QA workflow** on every format: locate a fact in a 53-page paper, locate a clause under a Word heading, then read the located block. |
| `test-drop-ingest.mjs` | The upload endpoint, including traversal, unregistered-workspace, and size-cap refusals. |
| `test-client-bundle.mjs` | The browser bundle loaded as the client module system loads it, driving drop → upload → draft, against a stub that enforces the real slot contract. |

The Word fixture is generated by `tests/make-docx-fixture.py` rather than
committed: it must contain no real content, and it is deliberately shaped to
reproduce the numeric-style-id trap that emptied a real document's outline. The
PowerPoint fixture is likewise generated by `tests/make-pptx-fixture.py`.

## Supported formats

| Format | Reader | Notes |
|---|---|---|
| `.pdf` | PyPDF2 (via a Python subprocess) | Page-per-block; a scanned PDF reports that it has no text layer instead of returning blanks |
| `.docx` | standard library `zipfile` + XML | Heading outline resolved through `styles.xml` |
| `.doc` | in-process OLE2/CFB parser | Legacy binary format; no heading outline |
| `.pptx` | standard library `zipfile` + XML | Slide-per-block with a slide-title outline |
| `.ppt` | in-process OLE2/CFB parser | Legacy binary format; reports blocks, not slide numbers |
| `.png` `.jpg` `.jpeg` | **not handled here** | These go to DeepSeek Harness's own image channel, which previews them and sends them as image blocks |

## Install

Requires a DeepSeek Harness profile (`dsh`) and a local Python interpreter.

```bash
# from npm
pnpm add dsh-doc-attach
# or let the harness manage the profile
dsh plugin add dsh-doc-attach
```

**Windows / local development** — the repository ships an installer that copies
the package into a profile's `node_modules` and registers it as a bundle. It
needs no network, which matters on a machine where the module registry is
unreachable:

```powershell
pwsh -File install.ps1 -DryRun   # report only, change nothing
pwsh -File install.ps1           # place the package, register the bundle
```

Then **restart the harness host**: client package metadata is cached per name
and never expires, so the browser half appears only after a restart. Reload the
page too — the composer's accepted-extension list lives in the browser bundle.

Verify:

```bash
curl http://127.0.0.1:3080/api/doc-attach/health
# -> {"ok":true,"route":"/api/doc-attach","extensions":[".pdf",".docx",".doc",".pptx",".ppt"],...}
```

Point it at a different interpreter if PyPDF2 is not on the default one:

```bash
export DSH_DOC_PYTHON=/usr/bin/python3
```

## Usage

1. Drop a document onto the harness page (or paste it), or copy it into the
   session workspace yourself.
2. The file lands in `<workspace>/.dsh-drops/` and its path is appended to the
   composer draft as an `@` reference.
3. Ask a question about it. The agent outlines the document, searches it to
   locate the passage, reads that block, and answers with a citation you can
   check against the file:

```
> @.dsh-drops/report.pdf 这份报告里模型的参数量是多少？

  document_search "671B"   -> 3 hits, first on page 1
  document_read   page 1   -> "…671B total parameters…"
  -> 671B，见第 1 页。
```

The tools are also usable directly, without dropping anything:

```
document_outline   { path: "D:/docs/plan.docx" }
document_search    { path: "D:/docs/plan.docx", query: "报名" }
document_read      { path: "D:/docs/plan.docx", start: 22, count: 6 }
```

### Screenshots

<!-- Add your own captures here; none are committed, so the repository stays
     free of personal document content. Suggested shots:
     docs/screenshot-drop.png      — the drop overlay over the composer
     docs/screenshot-outline.png   — document_outline output for a Word file
     docs/screenshot-answer.png    — a cited answer in the transcript -->

## Development

Development notes are kept in a **local-only** file, `docs/internal/dsh-doc-attach-dev-notes.md`
— a written record of how this plugin was built: the packaging and slot contracts
it has to satisfy, every pitfall hit along the way (and the root cause of each),
reusable snippets for registering a browser slot or an agent tool, a pre-flight
checklist for the next Harness plugin, and the release flow including OIDC
trusted publishing.

`docs/internal/` is listed in `.gitignore`, so those notes are deliberately
absent from this repository and from the published package: they describe a
local working environment and are not intended to be public. Clone this
repository and they are simply not there.

There is **no build step**: the host half is plain ESM and the browser half is a
hand-written classic script, loaded as-is by the client module system. Python
files are executed directly by the interpreter.

```
lib/extract/document_helper.py   format dispatch: extract / search / stats
lib/extract/doc_reader.py        OLE2/CFB container + legacy .doc piece table
lib/extract/ppt_reader.py        .pptx OOXML and legacy .ppt record tree
lib/extract/document-python.mjs  subprocess bridge (file handoff, not pipes)
plugins/read-document.mjs        the three agent tools
plugins/drop-ingest.mjs          the browser upload route
lib/client.js                    browser half: drop, paste, card, `@` reference
```

```bash
node tests/run-all.mjs      # all suites, offline
node tests/test-ppt-format.mjs   # one suite
```

Two conventions matter when changing this package:

- **Extension allow-lists live in four places** (tool layer, upload endpoint,
  browser bundle, Python backend) that cannot import one another.
  `tests/test-extension-consistency.mjs` fails if they disagree.
- **The browser bundle is a classic script**: no `import`, no JSX, React via the
  provided `require`. A list-type slot registration needs a top-level `id`.

## License

[MIT](LICENSE)

