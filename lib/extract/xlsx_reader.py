"""Spreadsheet (.xlsx) reader — one block per row, tagged with sheet and row number.

WHY ROW-PER-BLOCK
A worksheet is a grid, and the interesting unit in document Q&A is a record:
one row of a table. Making a row its own block means a search hit points at the
specific record rather than an entire sheet, a read window stays small enough to
be useful, and the citation a caller renders is precise — "Sheet1!第 12 行" is
something a reader can verify, where "第 3 块" would not be.

A whole sheet as one block was rejected for the second reason: a 20k-row export
would blow past the helper's per-block character ceiling and come back truncated,
hiding exactly the rows a question was about.

Text is the non-empty cells joined by ` | ` in column order, with trailing blanks
trimmed, so a row reads the way it appears on screen and stays greppable.

The outline is deliberately empty. A spreadsheet has no heading structure; a row
that merely looks bold is not a section boundary, and inventing one would put
noise in front of every caller that trusts the outline.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zipfile

# Reuse the Word reader's error vocabulary so the caller maps one set of codes
# for every container.
from doc_reader import DocError

MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
DOC_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

# A1-style cell reference, split so the column letters can be converted.
CELL_REF = re.compile(r"^([A-Z]+)(\d+)$")


def _entry(archive: zipfile.ZipFile, name: str):
    """One zip entry's bytes, or None when the package does not carry it."""
    try:
        return archive.read(name)
    except KeyError:
        return None


def _column_index(letters: str) -> int:
    """A1-style column letters to a 1-based index (A=1, Z=26, AA=27)."""
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index


def _shared_strings(archive: zipfile.ZipFile) -> list:
    """The workbook's shared string table; a cell of type `s` indexes into it."""
    payload = _entry(archive, "xl/sharedStrings.xml")
    if payload is None:
        return []
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        raise DocError("UNREADABLE", f"sharedStrings.xml is not parseable XML: {exc}")
    # One <si> may hold several runs; the cell's value is their concatenation.
    return ["".join(node.text or "" for node in item.iter(f"{MAIN}t"))
            for item in root.findall(f"{MAIN}si")]


def _sheet_targets(archive: zipfile.ZipFile) -> list:
    """[(worksheet name, zip entry name)] in workbook order.

    The worksheet part names are NOT necessarily `sheet1.xml`, `sheet2.xml`: the
    workbook's relationship table is what maps a sheet to its part, and renaming
    or reordering sheets in Excel breaks any positional assumption.
    """
    workbook = _entry(archive, "xl/workbook.xml")
    if workbook is None:
        raise DocError("UNREADABLE", "xl/workbook.xml is missing")

    targets = {}
    rels = _entry(archive, "xl/_rels/workbook.xml.rels")
    if rels is not None:
        try:
            rel_root = ET.fromstring(rels)
        except ET.ParseError as exc:
            raise DocError("UNREADABLE", f"workbook.xml.rels is not parseable XML: {exc}")
        for rel in rel_root.findall(f"{PKG_REL}Relationship"):
            identifier = rel.get("Id")
            target = rel.get("Target") or ""
            if identifier is None or target == "":
                continue
            targets[identifier] = target.lstrip("/") if target.startswith("/") else f"xl/{target}"

    try:
        root = ET.fromstring(workbook)
    except ET.ParseError as exc:
        raise DocError("UNREADABLE", f"workbook.xml is not parseable XML: {exc}")

    sheets = []
    for sheet in root.iter(f"{MAIN}sheet"):
        name = sheet.get("name") or "(unnamed)"
        entry = targets.get(sheet.get(f"{DOC_REL}id"))
        if entry is not None:
            sheets.append((name, entry))
    if not sheets:
        raise DocError("EMPTY_DOCUMENT", "the workbook holds no resolvable worksheets")
    return sheets


def _cell_text(cell, shared: list) -> str:
    """One cell's display text."""
    kind = cell.get("t")
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{MAIN}t")).strip()
    value = cell.find(f"{MAIN}v")
    if value is None or value.text is None:
        return ""
    raw = value.text.strip()
    if kind == "s":
        try:
            return shared[int(raw)].strip()
        except (ValueError, IndexError):
            return ""
    if kind == "b":
        return "TRUE" if raw == "1" else "FALSE"
    return raw  # numbers, and formula results of type str


def _row_text(cells: list) -> str:
    """Join a row's cells in column order, trimming trailing blanks."""
    if not cells:
        return ""
    highest = max(column for column, _ in cells)
    values = [""] * highest
    for column, text in cells:
        values[column - 1] = text
    while values and values[-1] == "":
        values.pop()
    return " | ".join(values)


def xlsx_blocks(path: str) -> list:
    """Extract one block per non-empty row. @raises DocError on a broken package."""
    try:
        with zipfile.ZipFile(path) as archive:
            shared = _shared_strings(archive)
            payloads = [(name, _entry(archive, entry)) for name, entry in _sheet_targets(archive)]
    except FileNotFoundError:
        raise DocError("NOT_FOUND", f"no such file: {path}")
    except zipfile.BadZipFile:
        raise DocError("UNREADABLE", "not a valid OOXML (zip) container")
    except OSError as exc:
        raise DocError("UNREADABLE", f"{type(exc).__name__}: {exc}")

    blocks = []
    for name, payload in payloads:
        if payload is None:
            continue
        try:
            root = ET.fromstring(payload)
        except ET.ParseError as exc:
            # One damaged sheet must not discard the rest of the workbook.
            blocks.append({"kind": "row", "text": "", "sheet": name,
                           "warning": f"worksheet {name} is not parseable XML: {exc}"})
            continue
        sheet_data = root.find(f"{MAIN}sheetData")
        if sheet_data is None:
            continue
        for row_node in sheet_data.findall(f"{MAIN}row"):
            cells = []
            for position, cell in enumerate(row_node.findall(f"{MAIN}c"), start=1):
                match = CELL_REF.match(cell.get("r") or "")
                column = _column_index(match.group(1)) if match is not None else position
                text = _cell_text(cell, shared)
                if text != "":
                    cells.append((column, text))
            if not cells:
                continue  # a blank row carries nothing a reader can use
            entry = {"kind": "row", "text": _row_text(cells), "sheet": name}
            number = row_node.get("r")
            if number is not None and number.isdigit():
                entry["row"] = int(number)
            blocks.append(entry)

    if not blocks:
        raise DocError("NO_TEXT_LAYER", "every worksheet is empty of text")
    return blocks
