"""Build a minimal but structurally honest legacy .doc fixture.

A `.doc` is a CFB container holding a `WordDocument` stream (the FIB plus text)
and a table stream (`0Table` or `1Table`) holding the piece table. This module
writes both, so the `.doc` reader is exercised end to end without a copy of Word
and without redistributing an Office template.

WHAT THE FIXTURE COVERS, AND WHY EACH PART IS THERE

  * TWO pieces, not one. The piece table is the part of the format that is
    easiest to get wrong and most expensive to get wrong, so the fixture has two
    entries whose character ranges chain: [0, wide) then [wide, wide+narrow).
  * One WIDE piece (UTF-16LE, CJK). Word stores text either as UTF-16 or as
    8-bit bytes in the document code page; the wide branch is the common one.
  * One COMPRESSED piece (8-bit, `FC_COMPRESSED` set, offset halved). The
    project's own notes flag this branch as implemented but never covered by a
    real sample, because a Chinese document cannot produce it. Here it is.
  * A body large enough to use the main FAT, plus a table stream small enough to
    use the mini stream, so one fixture covers both allocation paths.
  * A paragraph mark and a cell mark, so the block splitter sees both a
    paragraph and a table row rather than a single blob.

Usage: python make-doc-fixture.py <output.doc>
"""
from __future__ import annotations

import struct
import sys

import cfb_writer

# The reader refuses a WordDocument stream shorter than this, because the FIB
# fields it needs reach offset 0x01A6.
FIB_MIN = 0x01AA
WIDE_AT = 0x200                       # where the UTF-16 piece starts
SUPER = cfb_writer.MINI_CUTOFF        # forces WordDocument into the main FAT

WIDE_TEXT = '第一部分 报名记录\r姓名\x07城市\x07人数\x07\r合计\x07200\x07\r'
NARROW_TEXT = 'appendix alpha beta gamma\r'

FC_COMPRESSED = 0x40000000
F_WHICH_TBL_STM = 0x0200
LID_EN_US = 0x0409


def _clx(ccp_wide: int, ccp_narrow: int, fc_wide: int, fc_narrow: int) -> bytes:
    """A Clx holding one Pcdt with two pieces and no leading Prc blocks."""
    count = 2
    lcb = 12 * count + 4                     # (count+1) CPs + count PCDs
    cps = struct.pack('<3i', 0, ccp_wide, ccp_wide + ccp_narrow)
    pcd_wide = struct.pack('<HIH', 0, fc_wide, 0)
    pcd_narrow = struct.pack('<HIH', 0, fc_narrow, 0)
    return b'\x02' + struct.pack('<i', lcb) + cps + pcd_wide + pcd_narrow


def build() -> bytes:
    """Assemble the container."""
    wide_raw = WIDE_TEXT.encode('utf-16-le')
    narrow_raw = NARROW_TEXT.encode('cp1252')
    ccp_wide = len(WIDE_TEXT)
    ccp_narrow = len(NARROW_TEXT)

    fc_wide = WIDE_AT
    narrow_at = WIDE_AT + len(wide_raw)
    # The compressed flag lives in bit 30 and the stored offset is halved,
    # because an 8-bit piece addresses BYTES while an uncompressed piece
    # addresses UTF-16 code units.
    fc_narrow = (narrow_at * 2) | FC_COMPRESSED

    table_stream = _clx(ccp_wide, ccp_narrow, fc_wide, fc_narrow)

    word = bytearray(SUPER)
    struct.pack_into('<H', word, 0x00, 0xA5EC)                 # wIdent
    struct.pack_into('<H', word, 0x02, 0x00C1)                 # nFib
    struct.pack_into('<H', word, 0x06, LID_EN_US)              # lid -> cp1252
    struct.pack_into('<H', word, 0x0A, F_WHICH_TBL_STM)        # piece table lives in 1Table
    struct.pack_into('<i', word, 0x4C, ccp_wide + ccp_narrow)   # ccpText
    struct.pack_into('<i', word, 0x01A2, 0)                     # fcClx: table stream offset 0
    struct.pack_into('<i', word, 0x01A6, len(table_stream))     # lcbClx

    end_at = narrow_at + len(narrow_raw)
    if end_at > len(word):
        word.extend(b'\x00' * (end_at - len(word)))
    word[WIDE_AT:narrow_at] = wide_raw
    word[narrow_at:end_at] = narrow_raw

    if len(word) < FIB_MIN:
        raise AssertionError(f'WordDocument is {len(word)} bytes, below the FIB minimum')
    if len(word) < SUPER:
        raise AssertionError('WordDocument would fall into the mini stream; the fixture is meant to use the main FAT')

    return cfb_writer.build([
        ('WordDocument', bytes(word)),
        ('1Table', table_stream),
    ])


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write('usage: make-doc-fixture.py <output.doc>\n')
        return 2
    with open(sys.argv[1], 'wb') as handle:
        handle.write(build())
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
