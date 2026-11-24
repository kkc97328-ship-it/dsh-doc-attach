"""Minimal writer for the Compound File Binary container (OLE2 structured storage).

WHY THIS EXISTS
`.doc` and `.ppt` are not zip+XML like `.docx`/`.pptx`: both live inside a CFB
container, which is a miniature FAT filesystem in a single file. A committed
binary fixture would be opaque and unreviewable, and the real Office templates
this project used to read at run time cannot be redistributed. A generator is
text, reviewable, and can be aimed at the specific defects this reader has had.

The layout is the mirror of `lib/extract/doc_reader.py`'s `CompoundFile`, which
is its only consumer: 512-byte sectors, 64-byte mini sectors, and streams under
4096 bytes stored in the mini stream.

WHAT IT DELIBERATELY EXERCISES
A container whose streams are all small only ever touches the mini FAT; one
whose streams are all large only touches the main FAT. The readers here once got
the mini FAT wrong (they used sector NUMBERS where sector CONTENTS belong) and
that bug was invisible in every large file. So each generator puts at least one
large and one small stream in the same container, and one fixture covers both
allocation paths.
"""
from __future__ import annotations

import struct

SECTOR = 512
MINI_SECTOR = 64
MINI_CUTOFF = 4096

FREESECT = 0xFFFFFFFF
ENDOFCHAIN = 0xFFFFFFFE
FATSECT = 0xFFFFFFFD
NOSTREAM = 0xFFFFFFFF

SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def _dir_entry(name: str, kind: int, start: int, size: int) -> bytes:
    """One 128-byte directory entry, packed the way the reader unpacks it."""
    encoded = name.encode('utf-16-le') + b'\x00\x00'
    if len(encoded) > 64:
        raise ValueError(f'directory name too long: {name!r}')
    entry = bytearray(128)
    entry[0:len(encoded)] = encoded
    # The reader subtracts the terminator, so this length INCLUDES it.
    struct.pack_into('<H', entry, 0x40, len(encoded))
    entry[0x42] = kind          # 5 = root, 2 = stream
    entry[0x43] = 1             # colour: black
    struct.pack_into('<I', entry, 0x44, NOSTREAM)   # left sibling
    struct.pack_into('<I', entry, 0x48, NOSTREAM)   # right sibling
    struct.pack_into('<I', entry, 0x4C, NOSTREAM)   # child
    struct.pack_into('<I', entry, 0x74, start)
    struct.pack_into('<Q', entry, 0x78, size)
    return bytes(entry)


def build(streams) -> bytes:
    """Assemble a container holding `streams`, a list of (name, payload) pairs."""
    if not streams:
        raise ValueError('a container needs at least one stream')
    for name, payload in streams:
        if payload == b'':
            raise ValueError(f'stream {name!r} is empty; the reader treats zero length specially')
    names = [name for name, _ in streams]
    if len(set(names)) != len(names):
        raise ValueError(f'duplicate stream names: {names}')

    big = [(name, payload) for name, payload in streams if len(payload) >= MINI_CUTOFF]
    small = [(name, payload) for name, payload in streams if len(payload) < MINI_CUTOFF]

    # ── the mini stream, and the mini FAT that indexes it ─────────────────
    mini_data = bytearray()
    mini_fat = []
    small_slot = {}
    for name, payload in small:
        count = (len(payload) + MINI_SECTOR - 1) // MINI_SECTOR
        first = len(mini_fat)
        for index in range(count):
            mini_fat.append(ENDOFCHAIN if index == count - 1 else first + index + 1)
        small_slot[name] = (first, len(payload))
        mini_data.extend(payload)
        mini_data.extend(b'\x00' * (count * MINI_SECTOR - len(payload)))

    entries_per_sector = SECTOR // 4
    mini_fat_padded = list(mini_fat)
    if mini_fat_padded:
        while len(mini_fat_padded) % entries_per_sector != 0:
            mini_fat_padded.append(FREESECT)
    minifat_sectors = len(mini_fat_padded) // entries_per_sector

    # ── the directory ─────────────────────────────────────────────────────
    entry_count = 1 + len(streams)                 # root plus one per stream
    dir_sectors = (entry_count * 128 + SECTOR - 1) // SECTOR

    # ── big streams ───────────────────────────────────────────────────────
    big_layout = []
    for name, payload in big:
        big_layout.append((name, payload, (len(payload) + SECTOR - 1) // SECTOR))
    mini_sectors = (len(mini_data) + SECTOR - 1) // SECTOR

    # ── number the sectors ────────────────────────────────────────────────
    cursor = 0
    fat_first = cursor
    cursor += 1
    dir_first = cursor
    cursor += dir_sectors
    minifat_first = cursor
    cursor += minifat_sectors
    big_first = {}
    for name, _payload, count in big_layout:
        big_first[name] = cursor
        cursor += count
    mini_first = cursor
    cursor += mini_sectors
    total_sectors = cursor
    if total_sectors > entries_per_sector:
        raise ValueError(f'{total_sectors} sectors exceed one FAT sector; extend build()')

    # ── fill the FAT ──────────────────────────────────────────────────────
    fat = [FREESECT] * entries_per_sector

    def chain(first, count):
        for index in range(count):
            fat[first + index] = ENDOFCHAIN if index == count - 1 else first + index + 1

    fat[fat_first] = FATSECT
    chain(dir_first, dir_sectors)
    if minifat_sectors:
        chain(minifat_first, minifat_sectors)
    for name, _payload, count in big_layout:
        chain(big_first[name], count)
    if mini_sectors:
        chain(mini_first, mini_sectors)

    # ── the directory image ───────────────────────────────────────────────
    root = _dir_entry(
        'Root Entry',
        5,
        mini_first if mini_sectors else ENDOFCHAIN,
        len(mini_data),
    )
    directory = [root]
    for name, payload in streams:
        if name in small_slot:
            start, size = small_slot[name]
        else:
            start, size = big_first[name], len(payload)
        directory.append(_dir_entry(name, 2, start, size))
    dir_image = b''.join(directory)
    dir_image += b'\x00' * (dir_sectors * SECTOR - len(dir_image))

    minifat_image = b''.join(struct.pack('<I', value) for value in mini_fat_padded)

    # ── the header ────────────────────────────────────────────────────────
    header = bytearray(SECTOR)
    header[0:8] = SIGNATURE
    struct.pack_into('<H', header, 0x18, 0x003E)        # minor version
    struct.pack_into('<H', header, 0x1A, 0x0003)        # major version: 512-byte sectors
    struct.pack_into('<H', header, 0x1C, 0xFFFE)        # little-endian byte order
    struct.pack_into('<H', header, 0x1E, 9)             # sector shift -> 512
    struct.pack_into('<H', header, 0x20, 6)             # mini sector shift -> 64
    struct.pack_into('<I', header, 0x28, 0)             # v3 has no extra directory sectors
    struct.pack_into('<I', header, 0x2C, 1)             # exactly one FAT sector
    struct.pack_into('<I', header, 0x30, dir_first)
    struct.pack_into('<I', header, 0x38, MINI_CUTOFF)
    struct.pack_into('<I', header, 0x3C, minifat_first if minifat_sectors else ENDOFCHAIN)
    struct.pack_into('<I', header, 0x40, minifat_sectors)
    struct.pack_into('<I', header, 0x44, ENDOFCHAIN)    # no DIFAT sectors
    struct.pack_into('<I', header, 0x48, 0)
    difat = [FREESECT] * 109
    difat[0] = fat_first
    struct.pack_into('<109I', header, 0x4C, *difat)

    # ── assemble: header, then sectors in the order they were numbered ────
    out = bytearray(header)
    out.extend(struct.pack('<128I', *fat))
    out.extend(dir_image)
    out.extend(minifat_image)
    for _name, payload, count in big_layout:
        out.extend(payload)
        out.extend(b'\x00' * (count * SECTOR - len(payload)))
    if mini_data:
        out.extend(mini_data)
        out.extend(b'\x00' * (mini_sectors * SECTOR - len(mini_data)))

    if len(out) != SECTOR + total_sectors * SECTOR:
        raise AssertionError(f'assembled {len(out)} bytes, expected {SECTOR + total_sectors * SECTOR}')
    return bytes(out)
