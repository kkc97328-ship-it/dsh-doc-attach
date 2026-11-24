"""Build a small but structurally valid multi-page .pdf fixture.

Standard library only. A PDF is a text format with a cross-reference table, so
the fixture can be generated anywhere Python runs instead of being committed as
a binary, and the suites stop depending on a document that happens to sit in
someone's Downloads folder.

Design notes:

  * Content is deliberately plain ASCII in Helvetica. Embedding a font to draw
    CJK would mean shipping font bytes; a generated fixture covers the page /
    block / search / read paths, and a real CJK document can still be supplied
    through `DSH_DOC_PDF` for a local run.
  * Every page carries a title and numbered rows, so a reader can assert page
    boundaries rather than one blob.
  * Exactly one page carries the marker word `ZEBRA`. A search for it therefore
    has an expected page number, which makes the search checks meaningful
    instead of tautological.
  * Offsets in the xref table are computed from the emitted bytes, because
    PyPDF2 refuses a file whose table is wrong.

Usage: python make-pdf-fixture.py <output.pdf>
"""
from __future__ import annotations

import sys

PAGES = 5
ROWS_PER_PAGE = 8
MARKER = 'ZEBRA'
MARKER_PAGE = 3


def page_lines(page: int) -> list:
    """The text of one page, one entry per drawn line."""
    lines = [f'Section {page} of the generated fixture']
    for row in range(1, ROWS_PER_PAGE + 1):
        lines.append(f'row {page}-{row} alpha beta gamma delta')
    if page == MARKER_PAGE:
        lines.append(f'marker {MARKER} occurs only on this page')
    return lines


def content_stream(page: int) -> bytes:
    """One page's content stream: Helvetica, one line per row."""
    escaped = []
    for line in page_lines(page):
        text = line.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')
        escaped.append(f'({text}) Tj T*')
    body = '\n'.join(['BT', '/F1 12 Tf', '14 TL', '72 720 Td'] + escaped + ['ET'])
    return body.encode('latin-1')


def build() -> bytes:
    """Assemble the whole file, then fix up the offsets."""
    # Object 1 catalog, 2 pages tree, 3 font, then (page, contents) pairs.
    objects = {}
    kids = ' '.join(f'{4 + index * 2} 0 R' for index in range(PAGES))
    objects[1] = b'<< /Type /Catalog /Pages 2 0 R >>'
    objects[2] = f'<< /Type /Pages /Kids [{kids}] /Count {PAGES} >>'.encode('latin-1')
    objects[3] = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    for index in range(PAGES):
        page_obj = 4 + index * 2
        content_obj = page_obj + 1
        objects[page_obj] = (
            f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
            f'/Resources << /Font << /F1 3 0 R >> >> /Contents {content_obj} 0 R >>'
        ).encode('latin-1')
        stream = content_stream(index + 1)
        objects[content_obj] = (
            f'<< /Length {len(stream)} >>\nstream\n'.encode('latin-1') + stream + b'\nendstream'
        )

    total = 3 + PAGES * 2
    out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = {}
    for number in range(1, total + 1):
        offsets[number] = len(out)
        out += f'{number} 0 obj\n'.encode('latin-1')
        out += objects[number]
        out += b'\nendobj\n'

    xref_at = len(out)
    out += f'xref\n0 {total + 1}\n'.encode('latin-1')
    out += b'0000000000 65535 f \n'
    for number in range(1, total + 1):
        out += f'{offsets[number]:010d} 00000 n \n'.encode('latin-1')
    out += f'trailer\n<< /Size {total + 1} /Root 1 0 R >>\n'.encode('latin-1')
    out += f'startxref\n{xref_at}\n'.encode('latin-1')
    out += b'%%EOF\n'
    return bytes(out)


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write('usage: make-pdf-fixture.py <output.pdf>\n')
        return 2
    payload = build()
    with open(sys.argv[1], 'wb') as handle:
        handle.write(payload)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
