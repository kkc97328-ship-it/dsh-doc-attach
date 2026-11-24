"""Build a minimal but structurally honest legacy .ppt fixture.

A `.ppt` is a CFB container holding a `PowerPoint Document` stream, and that
stream is a tree of records. This module writes the tree by hand, so the `.ppt`
reader is exercised without a copy of PowerPoint and without redistributing an
Office template.

WHAT THE FIXTURE COVERS, AND WHY EACH PART IS THERE

  * Text inside Escher TEXT CONTAINERS (record type 61453). This project got
    that wrong once: it assumed `SlidePersistAtom (1011)` marked slide
    boundaries, and a real 620 KB deck then collapsed into a single block of
    master placeholder text. The fixture puts each shape's text in its own 61453
    container, and the assertion "three blocks, not one" is exactly the
    regression guard for that bug.
  * THREE containers, so the boundary logic is load-bearing. A reader that
    grouped by `SlideListWithText` alone would return one block here.
  * A multi-line atom, to cover the control-character normalisation that turns
    an in-record carriage return into a line break.
  * A deck stream large enough for the main FAT plus a second, small stream that
    only fits in the mini stream, so one fixture covers both allocation paths.

Deliberately NOT modelled: slide numbering. The reader reports blocks and no
slide numbers, because mapping a text container back to a real slide needs the
drawing tree correlated with the slide-persist records. A fixture that implied
otherwise would be asserting a behaviour the format does not give us for free.

Usage: python make-ppt-fixture.py <output.ppt>
"""
from __future__ import annotations

import struct
import sys

import cfb_writer

# Record types, mirroring lib/extract/ppt_reader.py.
RT_DOCUMENT = 1000
RT_SLIDE_LIST_WITH_TEXT = 4080
RT_TEXT_CHARS_ATOM = 4000
RT_TEXT_CONTAINER = 61453

CONTAINER_VERSION = 0xF

# One entry per Escher text container; each becomes one block.
SHAPES = [
    '报名记录 第一页\r已确认',
    '第二页 补充说明',
    '第三页 alpha beta gamma',
]

SUPER = cfb_writer.MINI_CUTOFF        # forces the deck stream into the main FAT


def _record(rec_type: int, body: bytes, version: int = 0, instance: int = 0) -> bytes:
    """One 8-byte record header followed by its body."""
    header = ((instance & 0x0FFF) << 4) | (version & 0x000F)
    return struct.pack('<HHI', header, rec_type, len(body)) + body


def _container(rec_type: int, body: bytes, instance: int = 0) -> bytes:
    """A container record: same header, version 0xF marks it as a container."""
    return _record(rec_type, body, version=CONTAINER_VERSION, instance=instance)


def build_stream() -> bytes:
    """The `PowerPoint Document` stream."""
    shapes = b''
    for text in SHAPES:
        atom = _record(RT_TEXT_CHARS_ATOM, text.encode('utf-16-le'))
        shapes += _container(RT_TEXT_CONTAINER, atom)
    slide_list = _container(RT_SLIDE_LIST_WITH_TEXT, shapes, instance=0)
    deck = _container(RT_DOCUMENT, slide_list)
    if len(deck) > SUPER:
        raise AssertionError('the deck outgrew the padding size; raise SUPER')
    return deck + b'\x00' * (SUPER - len(deck))


def build() -> bytes:
    """Assemble the container."""
    # "Current User" is a real stream in every PowerPoint file; here it also
    # forces the mini stream into existence so both allocation paths are used.
    return cfb_writer.build([
        ('PowerPoint Document', build_stream()),
        ('Current User', b'fixture-user'),
    ])


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write('usage: make-ppt-fixture.py <output.ppt>\n')
        return 2
    with open(sys.argv[1], 'wb') as handle:
        handle.write(build())
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
