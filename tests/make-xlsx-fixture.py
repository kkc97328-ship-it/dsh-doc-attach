"""Build a small but structurally honest .xlsx fixture.

Standard library only: an .xlsx is a zip of XML parts, so the fixture can be
generated wherever Python runs instead of being committed as a binary blob. The
test suite therefore runs in CI without a spreadsheet application.

It is shaped to exercise the paths the reader actually takes:

  * a shared-string table, because most cell text lives there and a reader that
    ignores it returns empty cells for every text column
  * numbers and a boolean, which take the other two value paths
  * a gap in a row (column B missing), so column alignment is checked rather
    than assumed
  * a completely blank row, which must not become a block
  * two worksheets, so sheet attribution is real and not hard-coded to one
  * CJK text, to prove the shared-string decode is UTF-8 and not ASCII

Usage: python make-xlsx-fixture.py <output.xlsx>
"""
from __future__ import annotations

import sys
import zipfile

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>
"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
"""

WORKBOOK = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="报名记录" sheetId="1" r:id="rId1"/>
    <sheet name="Notes" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>
"""

WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>
"""

# Order is load-bearing: sheet cells index into this table by position.
SHARED = [
    "城市", "报名人数", "备注",          # 0 1 2  (header row)
    "香港", "九龙", "已确认",            # 3 4 5
    "澳门", "待确认",                    # 6 7
    "Type", "Text",                      # 8 9  (second sheet header)
    "memo", "follow up in May",          # 10 11
]

SHEET1 = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="C1" t="s"><v>1</v></c>
      <c r="D1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>3</v></c>
      <c r="B2"><v>120</v></c>
      <c r="C2" t="s"><v>5</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>4</v></c>
      <c r="B3"><v>60</v></c>
      <c r="C3" t="s"><v>7</v></c>
    </row>
    <row r="4"/>
    <row r="5">
      <c r="A5" t="inlineStr"><is><t>合计</t></is></c>
      <c r="B5"><v>180</v></c>
      <c r="C5" t="b"><v>1</v></c>
    </row>
  </sheetData>
</worksheet>
"""

SHEET2 = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>8</v></c>
      <c r="B1" t="s"><v>9</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>10</v></c>
      <c r="B2" t="s"><v>11</v></c>
    </row>
  </sheetData>
</worksheet>
"""


def _shared_bytes() -> str:
    items = "".join(f"<si><t>{text}</t></si>" for text in SHARED)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        f'count="{len(SHARED)}" uniqueCount="{len(SHARED)}">{items}</sst>\n'
    )


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: make-xlsx-fixture.py <output.xlsx>\n")
        return 2
    target = sys.argv[1]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", ROOT_RELS)
        archive.writestr("xl/workbook.xml", WORKBOOK)
        archive.writestr("xl/_rels/workbook.xml.rels", WORKBOOK_RELS)
        archive.writestr("xl/sharedStrings.xml", _shared_bytes())
        archive.writestr("xl/worksheets/sheet1.xml", SHEET1)
        archive.writestr("xl/worksheets/sheet2.xml", SHEET2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
