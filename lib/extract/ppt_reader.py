#!/usr/bin/env python3
"""PowerPoint text extraction using only the standard library.

Two very different containers share the `.ppt` name:

  .pptx  OOXML — a zip holding `ppt/slides/slideN.xml`; text lives in `a:t`
         runs, and a title placeholder makes a natural heading.
  .ppt   the legacy binary format — an OLE2/CFB container holding a
         "PowerPoint Document" stream that is a tree of length-prefixed
         records; slide text sits in `TextCharsAtom` (UTF-16) and
         `TextBytesAtom` (8-bit) atoms under `SlideListWithText` records.

Neither has an installable library on the target machine (the module registry
is unreachable and LibreOffice is absent), so both are read here. The CFB layer
is shared with `doc_reader`, which already carries a verified implementation.

Validation: `.pptx` is verified against real 2.1–2.7 MB decks; `.ppt` against
the Office-shipped templates. Both are named per format in the project README.
"""
from __future__ import annotations

import re
import zipfile

# Reuse the Word reader's container layer and error vocabulary: the CFB format
# is identical for .doc and .ppt, and one error type keeps the caller's mapping
# uniform.
from doc_reader import CompoundFile, DocError

# ── OOXML presentation namespaces ─────────────────────────────────────────
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"

SLIDE_NAME = re.compile(r"^ppt/slides/slide(\d+)\.xml$")
NOTES_NAME = re.compile(r"^ppt/notesSlides/notesSlide(\d+)\.xml$")

# Placeholder types whose text is a slide title.
TITLE_PLACEHOLDERS = {"title", "ctrTitle"}

# ── legacy .ppt record types ──────────────────────────────────────────────
RT_DOCUMENT = 1000
RT_SLIDE_LIST_WITH_TEXT = 4080
RT_SLIDE_PERSIST_ATOM = 1011
RT_TEXT_CHARS_ATOM = 4000
RT_TEXT_BYTES_ATOM = 4008
RT_CSTRING = 4026

# Where slide text ACTUALLY lives. A structural dump of a 620 KB real deck
# showed every text atom's immediate parent to be this container type
# (0xF00D, x289), while `SlideListWithText` held only SlidePersistAtom records
# and no text at all. Grouping by slide-persist boundaries therefore produced
# one master-text blob; grouping by the text container is what the format does.
RT_TEXT_CONTAINER = 61453

# SlideListWithText instances: 0 = slides, 1 = masters, 2 = notes.
LIST_KIND = {0: "slide", 1: "master", 2: "notes"}

RT_CONTAINER_VERSION = 0xF

# Producer-defined internal labels, not document content: PowerPoint names its
# template placeholders `___PPT<n>`, and the equation editor names its embedded
# objects `Equation.<n>` / `Formel`. These are exact, anchored shapes emitted
# by the generators — not a list of words that appeared in one sample.
OBJECT_LABEL = re.compile(r"^(?:___PPT\d+|Equation\.\d+|Formel|Microsoft\s+Equation.*|Object\d*)$")


def _text_of(node) -> str:
    """Concatenate the `a:t` runs under one shape, honouring line breaks."""
    parts = []
    for child in node.iter():
        if child.tag == f"{A}t":
            parts.append(child.text or "")
        elif child.tag == f"{A}br":
            parts.append("\n")
    return "".join(parts)


def _title_of(shape) -> str | None:
    """Text of one shape when it is a title placeholder, else None."""
    for placeholder in shape.iter(f"{P}ph"):
        if placeholder.get("type") in TITLE_PLACEHOLDERS:
            text = _text_of(shape).strip()
            return text or None
    return None


def pptx_blocks(path: str) -> list:
    """Extract one block per slide, plus one per speaker-notes page.

    A slide is the unit a reader thinks in, so block numbering follows slide
    order; notes follow the slides and are marked as such.
    """
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            slides = sorted(
                ((int(SLIDE_NAME.match(n).group(1)), n) for n in names if SLIDE_NAME.match(n)),
            )
            if not slides:
                raise DocError("EMPTY_DOCUMENT", "the package holds no slides")
            notes = sorted(
                ((int(NOTES_NAME.match(n).group(1)), n) for n in names if NOTES_NAME.match(n)),
            )
            slide_xml = [(number, archive.read(name)) for number, name in slides]
            note_xml = [(number, archive.read(name)) for number, name in notes]
    except FileNotFoundError:
        raise DocError("NOT_FOUND", f"no such file: {path}") from None
    except zipfile.BadZipFile:
        raise DocError("UNREADABLE", "not a valid OOXML (zip) container") from None
    except OSError as exc:
        raise DocError("UNREADABLE", f"{type(exc).__name__}: {exc}") from None

    import xml.etree.ElementTree as ET

    blocks = []
    for number, payload in slide_xml:
        try:
            root = ET.fromstring(payload)
        except ET.ParseError as exc:
            blocks.append({"kind": "slide", "text": "", "slide": number,
                           "warning": f"slide {number} is not parseable XML: {exc}"})
            continue
        title = None
        lines = []
        for shape in root.iter(f"{P}sp"):
            text = _text_of(shape).strip()
            if text == "":
                continue
            heading = _title_of(shape)
            if heading is not None and title is None:
                title = heading
            lines.append(text)
        entry = {"kind": "slide", "text": "\n".join(lines), "slide": number}
        if title is not None:
            # A title makes the slide addressable by name in the outline.
            entry["title"] = title
            entry["level"] = 1
        blocks.append(entry)

    for number, payload in note_xml:
        try:
            root = ET.fromstring(payload)
        except ET.ParseError:
            continue
        # The slide-number placeholder repeats the number; drop standalone digits.
        parts = [line for line in (_text_of(shape).strip() for shape in root.iter(f"{P}sp"))
                 if line and not line.isdigit()]
        if parts:
            blocks.append({"kind": "note", "text": "\n".join(parts), "slide": number})

    if not any(block.get("text", "").strip() for block in blocks):
        raise DocError("NO_TEXT_LAYER", "every slide is empty of text (likely an image-only deck)")
    return blocks


def _walk_records(data: bytes, start: int, end: int, depth: int, out: list, kind: str = "other") -> None:
    """Walk the legacy record tree, collecting text atoms with their list kind."""
    if depth > 12:  # guard against a malformed tree claiming deep nesting
        return
    pos = start
    while pos + 8 <= end:
        header = int.from_bytes(data[pos:pos + 2], "little")
        rec_version = header & 0x000F
        rec_instance = header >> 4
        rec_type = int.from_bytes(data[pos + 2:pos + 4], "little")
        rec_len = int.from_bytes(data[pos + 4:pos + 8], "little")
        body = pos + 8
        if rec_len < 0 or body + rec_len > end:
            return  # truncated record: stop rather than read past the stream
        if rec_version == RT_CONTAINER_VERSION:
            child_kind = kind
            if rec_type == RT_SLIDE_LIST_WITH_TEXT:
                child_kind = LIST_KIND.get(rec_instance, "other")
            if rec_type == RT_TEXT_CONTAINER:
                # One text container holds one shape's text; the boundary is
                # what separates one block from the next.
                out.append({"list": child_kind, "boundary": True})
            _walk_records(data, body, body + rec_len, depth + 1, out, child_kind)
        elif rec_type == RT_TEXT_CHARS_ATOM:
            out.append({"list": kind, "raw": data[body:body + rec_len], "wide": True})
        elif rec_type in (RT_TEXT_BYTES_ATOM, RT_CSTRING):
            out.append({"list": kind, "raw": data[body:body + rec_len], "wide": False})
        pos = body + rec_len


def _clean_atom(raw: bytes, wide: bool) -> str:
    """Decode one text atom and normalise the format's control characters."""
    text = raw.decode("utf-16-le" if wide else "cp1252", errors="replace")
    out = []
    for char in text:
        if char in ("\r", "\v", "\n"):
            out.append("\n")
        elif char in ("\x0b", "\x0c"):
            out.append("\n")
        elif ord(char) < 0x20:
            continue
        else:
            out.append(char)
    return "".join(out).strip()


# A container holding only placeholder punctuation (a page-number or bullet
# mark) carries no readable content. This is a shape test, not a word list.
PLACEHOLDER_ONLY = re.compile(r"^[\s*\-–—.·•\d/]+$")


def _group_blocks(atoms: list) -> list:
    """Group text atoms into one list per text container."""
    groups = []
    current = None
    for atom in atoms:
        if atom.get("boundary"):
            if current is not None:
                groups.append(current)
            current = []
            continue
        if "raw" not in atom:
            continue
        if atom["list"] == "notes":
            continue  # speaker notes are not slide content
        if current is None:
            current = []  # atoms ahead of the first boundary still belong somewhere
        current.append(atom)
    if current:
        groups.append(current)
    return groups


def ppt_blocks(path: str) -> list:
    """Extract text from a legacy binary .ppt, one block per text container.

    Deliberately reports NO slide numbers. Mapping a text container back to a
    real slide requires correlating the drawing tree with the slide-persist
    records, which this reader does not do; numbering containers as "slide N"
    would report an internal counter as if it were the slide a user sees.

    Known limitation: the slide master's placeholder wording (for example
    "Click to edit Master title style") can appear among the blocks, because
    the master's drawing reaches the same container type as slide drawings.
    """
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except FileNotFoundError:
        raise DocError("NOT_FOUND", f"no such file: {path}") from None
    except OSError as exc:
        raise DocError("UNREADABLE", f"{type(exc).__name__}: {exc}") from None

    container = CompoundFile(data)
    try:
        stream = container.stream("PowerPoint Document")
    except DocError:
        raise DocError("UNREADABLE", "the container holds no PowerPoint Document stream") from None

    atoms = []
    _walk_records(stream, 0, len(stream), 0, atoms)
    if not atoms:
        raise DocError("UNREADABLE", "no text records found in the presentation stream")

    groups = _group_blocks(atoms)
    if not any(groups):
        # No text container was recognised; fall back to one block per atom
        # rather than returning an empty deck.
        groups = [[atom] for atom in atoms if "raw" in atom]

    global_seen = set()
    blocks = []
    for group in groups:
        lines = []
        for atom in group:
            text = _clean_atom(atom["raw"], atom["wide"])
            if text == "" or OBJECT_LABEL.match(text) or PLACEHOLDER_ONLY.match(text):
                continue
            if text in global_seen:
                continue  # a master or footer repeats the same string per slide
            global_seen.add(text)
            lines.append(text)
        if not lines:
            continue
        blocks.append({"kind": "paragraph", "text": "\n".join(lines)})
    if not blocks:
        raise DocError("NO_TEXT_LAYER", "the presentation holds no readable text")
    return blocks
