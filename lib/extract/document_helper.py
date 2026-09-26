#!/usr/bin/env python3
"""Document text backend for the DSH document-attachment plugin.

Handles PDF (via PyPDF2) and OOXML Word/PPT (via the standard library's
`zipfile`, which is why no python-docx is needed — this environment has no
reachable package index).

Everything is normalised to one concept: a **block**. For a PDF a block is a
page; for a Word document it is a paragraph, a heading, or one table row. The
three modes then work identically across formats:

  extract  a window of blocks (precise reading)
  search   query hits with block numbers and enclosing heading (locating)
  stats    block count, per-block size, and the heading outline (whole view)

Results travel through a FILE, not stdout. That is a hard requirement: under
the confined sandbox this plugin runs in, a child process cannot open named
pipes, so Node's `execFile`/`spawn` with piped stdio fails with `spawn EPERM`.
Writing to `--out` and spawning with `stdio: 'ignore'` is the permitted mode,
and it also removes any stdout buffer ceiling.

Usage:
    python document_helper.py --file <path> --mode extract [--start N] [--count N]
    python document_helper.py --file <path> --mode search --query TEXT [--regex]
    python document_helper.py --file <path> --mode stats
    # any mode also accepts: [--out <json>] [--log <text>] [--cache-dir <dir>]
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import traceback
import warnings
import zipfile

warnings.filterwarnings("ignore")

# Windows consoles default to a legacy code page, and CJK text crashes write()
# without this. Errors are replaced rather than raised so one unmappable glyph
# cannot lose a whole document.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_OUT = None
_LOG = None
_CACHE_DIR = None

# ── OOXML namespaces ──────────────────────────────────────────────────────
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

# Heading styles vary by language and generator; match the families that
# actually appear rather than one exact string.
HEADING_STYLE = re.compile(r"^(?:heading|标题|titre|überschrift)\s*(\d+)$", re.IGNORECASE)
MAX_HEADING_LEVEL = 9


def emit(payload: dict) -> None:
    """Write the single JSON result to the out file (and stdout when no file)."""
    body = json.dumps(payload, ensure_ascii=False)
    if _OUT is None:
        sys.stdout.write(body)
        sys.stdout.flush()
        return
    with open(_OUT, "w", encoding="utf-8") as handle:
        handle.write(body)


def fail(code: str, message: str) -> None:
    """Report a structured failure the Node side can branch on."""
    emit({"ok": False, "error": {"code": code, "message": message}})


def write_log(text: str) -> None:
    """Record a crash traceback where the caller can read it."""
    if _LOG is None:
        return
    try:
        with open(_LOG, "w", encoding="utf-8") as handle:
            handle.write(text)
    except OSError:
        pass


# ── cache ─────────────────────────────────────────────────────────────────
# Bumped whenever the extraction logic changes shape, so a cached result from
# an older extractor can never be served as if it came from the current one.
# Without this the key (path + size + mtime) stays valid across a code change
# and silently returns stale blocks.
CACHE_VERSION = 3


def cache_key(path: str) -> str:
    """Identity of one document version AND extractor version."""
    stat = os.stat(path)
    raw = f"v{CACHE_VERSION}|{os.path.abspath(path)}|{stat.st_size}|{stat.st_mtime_ns}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def cache_read(key: str):
    """Return the cached blocks for one document version, or None."""
    if _CACHE_DIR is None:
        return None
    try:
        with open(os.path.join(_CACHE_DIR, f"{key}.json"), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def cache_write(key: str, payload: dict) -> None:
    """Persist blocks so repeated searches reuse one extraction pass."""
    if _CACHE_DIR is None:
        return
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        target = os.path.join(_CACHE_DIR, f"{key}.json")
        tmp = f"{target}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        os.replace(tmp, target)
    except OSError:
        pass


# ── PDF ───────────────────────────────────────────────────────────────────
def blocks_from_pdf(path: str):
    """Extract one block per page. @returns (blocks, error)."""
    try:
        with open(path, "rb") as handle:
            payload_bytes = handle.read()
    except FileNotFoundError:
        return None, ("NOT_FOUND", f"no such file: {path}")
    except OSError as exc:
        return None, ("UNREADABLE", f"{type(exc).__name__}: {exc}")

    try:
        import PyPDF2
    except ImportError as exc:
        return None, ("BACKEND_UNAVAILABLE", f"PyPDF2 is not importable: {exc}")

    try:
        # The bytes are read up front and handed to BytesIO deliberately:
        # PyPDF2 reads page content lazily, so a PdfReader built on a `with`
        # block's handle fails every later extract_text() with "seek of closed
        # file".
        reader = PyPDF2.PdfReader(io.BytesIO(payload_bytes))
        page_count = len(reader.pages)
    except Exception as exc:  # noqa: BLE001 - any parse failure is reported
        return None, ("UNREADABLE", f"{type(exc).__name__}: {exc}")

    if page_count == 0:
        return None, ("EMPTY_DOCUMENT", "the PDF reports zero pages")

    blocks = []
    for number in range(page_count):
        try:
            text = reader.pages[number].extract_text() or ""
        except Exception as exc:  # noqa: BLE001 - one bad page must not lose the rest
            blocks.append({"kind": "page", "text": "", "warning": f"{type(exc).__name__}: {exc}"})
            continue
        blocks.append({"kind": "page", "text": text})
    return blocks, None


# ── OOXML shared helpers ──────────────────────────────────────────────────
def read_zip_entry(archive: zipfile.ZipFile, name: str):
    """Read one entry as text, or None when absent/unreadable."""
    try:
        return archive.read(name).decode("utf-8", errors="replace")
    except (KeyError, OSError):
        return None


def para_text(node, ns: str = W) -> str:
    """Concatenate the visible text of one paragraph-like node.

    Only `w:t` (and equivalent) runs are read, which naturally skips deleted
    text (`w:delText`) — a tracked deletion must not reappear as content.
    """
    parts = []
    for child in node.iter():
        if child.tag == f"{ns}t":
            parts.append(child.text or "")
        elif child.tag == f"{ns}tab":
            parts.append("\t")
        elif child.tag in (f"{ns}br", f"{ns}cr"):
            parts.append("\n")
    return "".join(parts)


def load_style_table(archive: zipfile.ZipFile) -> dict:
    """Map `styleId` → its name, base style, and outline level.

    This table is essential rather than decorative: a `w:pStyle` value is a
    STYLE ID, not a style name. Documents produced by WPS and several other
    exporters use bare numeric ids (`val="2"`) whose meaning lives only in
    `styles.xml` (`name="heading 1"`). Matching the id against a heading
    pattern therefore finds nothing, which is exactly how an outline silently
    came back empty on a real Word document.
    """
    raw = read_zip_entry(archive, "word/styles.xml")
    if raw is None:
        return {}
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return {}

    table = {}
    for style in root.iter(f"{W}style"):
        style_id = style.get(f"{W}styleId")
        if style_id is None:
            continue
        name_node = style.find(f"{W}name")
        base_node = style.find(f"{W}basedOn")
        outline_node = style.find(f"{W}pPr/{W}outlineLvl")
        entry = {
            "name": name_node.get(f"{W}val") if name_node is not None else None,
            "basedOn": base_node.get(f"{W}val") if base_node is not None else None,
            "outline": None,
        }
        if outline_node is not None:
            try:
                entry["outline"] = int(outline_node.get(f"{W}val"))
            except (TypeError, ValueError):
                pass
        table[style_id] = entry
    return table


def style_chain_outline(style_id, styles: dict, depth: int = 0):
    """First outline level found along a style's `basedOn` chain."""
    if style_id is None or depth > 10:
        return None
    entry = styles.get(style_id)
    if entry is None:
        return None
    if entry.get("outline") is not None:
        return entry["outline"]
    return style_chain_outline(entry.get("basedOn"), styles, depth + 1)


def level_from_outline(outline: int):
    """Convert a zero-based outline level to a 1-based heading level."""
    level = outline + 1
    return level if 1 <= level <= MAX_HEADING_LEVEL else None


def heading_level(node, styles: dict, ns: str = W):
    """Heading level of one paragraph, or None when it is body text.

    Three signals are honoured, in order of authority, because generators
    differ: an explicit outline level on the paragraph, an outline level
    inherited through the paragraph style, and finally the style's NAME
    (resolved through `styles.xml`, since the id alone is meaningless).
    """
    ppr = node.find(f"{ns}pPr")
    if ppr is None:
        return None

    direct = ppr.find(f"{ns}outlineLvl")
    if direct is not None:
        try:
            level = level_from_outline(int(direct.get(f"{ns}val")))
            if level is not None:
                return level
        except (TypeError, ValueError):
            pass

    style = ppr.find(f"{ns}pStyle")
    if style is None:
        return None
    style_id = (style.get(f"{ns}val") or "").strip()

    inherited = style_chain_outline(style_id, styles)
    if inherited is not None:
        level = level_from_outline(inherited)
        if level is not None:
            return level

    # Fall back to the resolved style NAME, walking basedOn so a custom style
    # derived from "heading 1" still counts.
    seen = set()
    cursor = style_id
    while cursor is not None and cursor not in seen:
        seen.add(cursor)
        entry = styles.get(cursor)
        if entry is None:
            cursor = None
            continue
        name = (entry.get("name") or "").strip()
        # A character style ("标题 1 Char") describes runs, not paragraphs.
        if name and not name.lower().endswith("char"):
            match = HEADING_STYLE.match(name)
            if match:
                level = int(match.group(1))
                if 1 <= level <= MAX_HEADING_LEVEL:
                    return level
        cursor = entry.get("basedOn")
    return None


def blocks_from_docx(path: str):
    """Extract Word blocks in document order. @returns (blocks, error)."""
    try:
        with zipfile.ZipFile(path) as archive:
            document = read_zip_entry(archive, "word/document.xml")
            styles = load_style_table(archive)
    except FileNotFoundError:
        return None, ("NOT_FOUND", f"no such file: {path}")
    except zipfile.BadZipFile:
        return None, ("UNREADABLE", "not a valid OOXML (zip) container")
    except OSError as exc:
        return None, ("UNREADABLE", f"{type(exc).__name__}: {exc}")

    if document is None:
        return None, ("UNREADABLE", "word/document.xml is missing")

    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(document)
    except ET.ParseError as exc:
        return None, ("UNREADABLE", f"document.xml is not parseable XML: {exc}")

    body = root.find(f"{W}body")
    if body is None:
        return None, ("UNREADABLE", "document.xml has no w:body")

    blocks = []
    for node in body:
        if node.tag == f"{W}p":
            text = para_text(node).strip()
            level = heading_level(node, styles)
            kind = "heading" if level is not None else "paragraph"
            if text == "":
                # Drop empty paragraphs AND empty headings. Neither carries
                # readable content, and keeping empty headings would pollute
                # the outline with bare entries that mean nothing to a reader.
                continue
            entry = {"kind": kind, "text": text}
            if level is not None:
                entry["level"] = level
            blocks.append(entry)
        elif node.tag == f"{W}tbl":
            # One block per table ROW: search hits then point at a specific
            # row instead of an entire table, and a read window stays useful.
            for row_index, row in enumerate(node.findall(f"{W}tr"), start=1):
                cells = []
                for cell in row.findall(f"{W}tc"):
                    cell_text = " ".join(
                        part for part in (para_text(p).strip() for p in cell.findall(f"{W}p")) if part
                    )
                    cells.append(cell_text)
                if any(cells):
                    blocks.append({
                        "kind": "table",
                        "text": " | ".join(cells),
                        "row": row_index,
                    })
    if not blocks:
        # A document whose body yields nothing is reported as such rather than
        # as a successful empty read.
        return None, ("EMPTY_DOCUMENT", "the document body contains no readable paragraphs")
    return blocks, None


# ── legacy .doc ───────────────────────────────────────────────────────────
def blocks_from_doc(path: str):
    """Extract a legacy .doc through the standard-library container reader.

    `.doc` is OLE2/CFB, not OOXML, so it needs its own reader. That reader sits
    in `doc_reader.py` beside this file (Python puts the script's directory on
    sys.path) and is imported lazily, so a deployment missing it still reads
    PDF and .docx.
    """
    try:
        import doc_reader
    except ImportError as exc:
        return None, ("BACKEND_UNAVAILABLE", f"doc_reader.py is not importable: {exc}")
    try:
        return doc_reader.doc_blocks(path), None
    except doc_reader.DocError as exc:
        return None, (exc.code, str(exc))


# ── PowerPoint ────────────────────────────────────────────────────────────
def blocks_from_presentation(path: str, fmt: str):
    """Extract a presentation's text through the standard-library reader.

    `.pptx` is OOXML (slide numbers are real, titles give an outline) while
    `.ppt` is the legacy binary format read from its record tree. Both live in
    `ppt_reader.py` beside this file and are imported lazily so a deployment
    missing it still reads the other formats.
    """
    try:
        import ppt_reader
    except ImportError as exc:
        return None, ("BACKEND_UNAVAILABLE", f"ppt_reader.py is not importable: {exc}")
    try:
        if fmt == "pptx":
            return ppt_reader.pptx_blocks(path), None
        return ppt_reader.ppt_blocks(path), None
    except ppt_reader.DocError as exc:
        return None, (exc.code, str(exc))


# ── loader ────────────────────────────────────────────────────────────────
FORMAT_BY_EXT = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".doc": "doc",
    ".pptx": "pptx",
    ".ppt": "ppt",
}
# A .pptx has real slides; a legacy .ppt does not expose a reliable slide
# number, so its unit is the block its reader actually produces.
UNIT_BY_FORMAT = {
    "pdf": "page",
    "docx": "block",
    "doc": "block",
    "pptx": "slide",
    "ppt": "block",
}


def load_document(path: str):
    """Extract and cache a document's blocks. @returns (payload, error)."""
    ext = os.path.splitext(path)[1].lower()
    fmt = FORMAT_BY_EXT.get(ext)
    if fmt is None:
        return None, ("UNSUPPORTED_FORMAT", f"unsupported extension: {ext or '(none)'}")

    try:
        key = cache_key(path)
    except FileNotFoundError:
        return None, ("NOT_FOUND", f"no such file: {path}")
    except OSError as exc:
        return None, ("UNREADABLE", f"{type(exc).__name__}: {exc}")

    cached = cache_read(key)
    if cached is not None:
        return cached, None

    if fmt == "pdf":
        blocks, error = blocks_from_pdf(path)
    elif fmt == "doc":
        blocks, error = blocks_from_doc(path)
    elif fmt in ("pptx", "ppt"):
        blocks, error = blocks_from_presentation(path, fmt)
    else:
        blocks, error = blocks_from_docx(path)

    if error is not None:
        return None, error

    payload = {
        "format": fmt,
        "unit": UNIT_BY_FORMAT[fmt],
        "blocks": blocks,
    }
    cache_write(key, payload)
    return payload, None


def _outline_entry(block: dict):
    """A block's outline text and level, or None when it is body content.

    Two readers express a heading differently and both are honoured here: a
    Word heading is its own `kind: "heading"` block, while a presentation slide
    carries `title`/`level` on the slide block itself. Recognising only the
    first left every deck's outline empty even though the titles were read.
    """
    if block.get("kind") == "heading":
        return block.get("level", 1), block.get("text", "")
    if block.get("title"):
        return block.get("level", 1), block["title"]
    return None


def heading_breadcrumb(blocks: list, index: int) -> str:
    """The nearest preceding heading, used to place a hit in context."""
    for cursor in range(index, -1, -1):
        entry = _outline_entry(blocks[cursor])
        if entry is not None:
            return entry[1]
    return ""


def outline_of(blocks: list) -> list:
    """Heading outline as (level, text, block number) rows."""
    rows = []
    for position, block in enumerate(blocks):
        entry = _outline_entry(block)
        if entry is None:
            continue
        rows.append({"block": position + 1, "level": entry[0], "text": entry[1]})
    return rows


# ── modes ─────────────────────────────────────────────────────────────────
def mode_extract(payload: dict, args: argparse.Namespace) -> None:
    """Return one window of blocks."""
    if args.start < 1:
        fail("BAD_RANGE", f"--start must be >= 1, got {args.start}")
        return
    if args.count < 1:
        fail("BAD_RANGE", f"--count must be >= 1, got {args.count}")
        return
    blocks = payload["blocks"]
    total = len(blocks)
    first = args.start
    last = min(total, args.start + args.count - 1)
    window = []
    for number in range(first, last + 1):
        block = blocks[number - 1]
        row = {"index": number, "kind": block.get("kind", "paragraph"), "text": block.get("text", "")}
        # Structural fields a reader produces must survive this projection.
        # Omitting `slide`/`title` here dropped a presentation's real slide
        # number and its title, leaving the caller with an opaque block index.
        for extra in ("level", "row", "slide", "title", "warning"):
            if extra in block:
                row[extra] = block[extra]
        window.append(row)
    has_text = any(row["text"].strip() for row in window)
    emit({
        "ok": True,
        "format": payload["format"],
        "unit": payload["unit"],
        "blockCount": total,
        "start": first,
        "end": last,
        "hasMore": last < total,
        "textLayer": has_text or any(b.get("text", "").strip() for b in blocks),
        "blocks": window,
    })


def mode_stats(payload: dict) -> None:
    """Cheap whole-document view: size per block plus the heading outline."""
    blocks = payload["blocks"]
    rows = []
    total_chars = 0
    empty = []
    for position, block in enumerate(blocks):
        chars = len(block.get("text", "").strip())
        total_chars += chars
        if chars == 0:
            empty.append(position + 1)
        rows.append({"block": position + 1, "kind": block.get("kind", "paragraph"), "chars": chars})
    emit({
        "ok": True,
        "format": payload["format"],
        "unit": payload["unit"],
        "blockCount": len(blocks),
        "totalChars": total_chars,
        "textLayer": total_chars > 0,
        "emptyBlocks": empty,
        "outline": outline_of(blocks),
        "blocks": rows,
    })


def mode_search(payload: dict, args: argparse.Namespace) -> None:
    """Return query hits with block numbers and enclosing headings."""
    if args.query is None or args.query == "":
        fail("BAD_QUERY", "--mode search requires --query")
        return
    if args.max_hits < 1:
        fail("BAD_RANGE", f"--max-hits must be >= 1, got {args.max_hits}")
        return

    if args.regex:
        try:
            pattern = re.compile(args.query, re.IGNORECASE)
        except re.error as exc:
            fail("BAD_QUERY", f"invalid regular expression: {exc}")
            return
    else:
        pattern = re.compile(re.escape(args.query), re.IGNORECASE)

    blocks = payload["blocks"]
    hits = []
    truncated = False
    for position, block in enumerate(blocks):
        text = block.get("text", "")
        if not text:
            continue
        matches = list(pattern.finditer(text))
        if not matches:
            continue
        if len(hits) >= args.max_hits:
            truncated = True
            break
        # ONE hit per block. A block is the unit the caller then reads or
        # re-searches, so emitting an identical row per occurrence turns a
        # common term into pure noise; `occurrences` keeps that signal instead.
        first = matches[0]
        start = max(0, first.start() - args.context)
        end = min(len(text), first.end() + args.context)
        hits.append({
            "block": position + 1,
            "kind": block.get("kind", "paragraph"),
            "offset": first.start(),
            "match": first.group(0),
            "occurrences": len(matches),
            "snippet": re.sub(r"\s+", " ", text[start:end]).strip(),
            "heading": heading_breadcrumb(blocks, position),
        })

    emit({
        "ok": True,
        "format": payload["format"],
        "unit": payload["unit"],
        "blockCount": len(blocks),
        "query": args.query,
        "regex": bool(args.regex),
        "hitCount": len(hits),
        "truncated": truncated,
        "textLayer": any(b.get("text", "").strip() for b in blocks),
        "hits": hits,
    })


def main() -> None:
    global _OUT, _LOG, _CACHE_DIR
    parser = argparse.ArgumentParser(description="Extract, search, or outline a document.")
    parser.add_argument("--file", required=True, help="Absolute path to the document.")
    parser.add_argument("--mode", default="extract", choices=["extract", "search", "stats"])
    parser.add_argument("--start", type=int, default=1, help="extract: 1-based first block.")
    parser.add_argument("--count", type=int, default=5, help="extract: blocks to return.")
    parser.add_argument("--query", default=None, help="search: literal text or pattern.")
    parser.add_argument("--regex", action="store_true", help="search: treat --query as a regex.")
    parser.add_argument("--max-hits", type=int, default=30, help="search: hit ceiling.")
    parser.add_argument("--context", type=int, default=160, help="search: snippet chars per side.")
    parser.add_argument("--cache-dir", default=None, help="Reuse extracted blocks here.")
    parser.add_argument("--out", default=None, help="JSON result path; stdout when omitted.")
    parser.add_argument("--log", default=None, help="Traceback path for crashes.")
    args = parser.parse_args()
    _OUT = args.out
    _LOG = args.log
    _CACHE_DIR = args.cache_dir

    try:
        payload, error = load_document(args.file)
        if error is not None:
            fail(error[0], error[1])
            return
        if args.mode == "extract":
            mode_extract(payload, args)
        elif args.mode == "stats":
            mode_stats(payload)
        else:
            mode_search(payload, args)
    except Exception:  # noqa: BLE001 - a crash must still produce an envelope
        detail = traceback.format_exc()
        write_log(detail)
        lines = detail.strip().splitlines()
        fail("EXTRACTION_FAILED", lines[-1] if lines else "unknown crash")


if __name__ == "__main__":
    main()
