#!/usr/bin/env python3
"""Build a synthetic Word fixture for the document backend tests.

Usage: python make-docx-fixture.py <output.docx>

Why a generator instead of a committed binary: the fixture must contain no
real content, and it has to be reproducible and inspectable in review. It is
also deliberately shaped to guard a defect that shipped — the style ids are
BARE NUMBERS whose meaning lives only in styles.xml (`styleId="2"` with
`name="heading 1"`), which is exactly how a real Word document defeated an
earlier heading detector that matched against the id.
"""
import sys
import zipfile

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
ODR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

CONTENT_TYPES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="{CT}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""

ROOT_RELS = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{REL}">
  <Relationship Id="rId1" Type="{ODR}/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOC_RELS = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="{REL}">
  <Relationship Id="rId1" Type="{ODR}/styles" Target="styles.xml"/>
</Relationships>"""

# Numeric ids with names that carry the meaning — the real-world trap.
STYLES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W}">
  <w:style w:type="paragraph" w:styleId="1"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="3"><w:name w:val="heading 2"/><w:basedOn w:val="2"/></w:style>
  <w:style w:type="paragraph" w:styleId="14"><w:name w:val="List Paragraph"/></w:style>
  <w:style w:type="character" w:styleId="13"><w:name w:val="标题 1 Char"/></w:style>
</w:styles>"""


def para(text, style_id=None):
    """One paragraph, optionally carrying a paragraph style."""
    ppr = f'<w:pPr><w:pStyle w:val="{style_id}"/></w:pPr>' if style_id else ""
    return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def table(rows):
    """A table whose every row becomes one block."""
    body = []
    for row in rows:
        cells = "".join(
            f"<w:tc>{para(cell)}</w:tc>" for cell in row
        )
        body.append(f"<w:tr>{cells}</w:tr>")
    return f"<w:tbl>{''.join(body)}</w:tbl>"


BLOCKS = [
    para("测试方案 2026", "2"),
    para("本方案说明校内集中实习与校外分散实习的区别，以及报名流程。"),
    para("以下列出两种实习形式的适用对象。"),
    para("第一节 报名流程", "3"),
    para("学生须在第七学期开学前两周提交申请表，报名给班长。"),
    table([
        ["项目", "时间要求"],
        ["提交材料", "开学前两周"],
        ["报名方式", "统一报给班长"],
    ]),
    para("第二节 材料清单", "3"),
    para("需提交承诺书与三方协议，签字完整后拍照发送给带班老师。"),
    # Deliberately repeats a term inside ONE block, so the dedup behaviour is
    # actually exercised: a block must appear once with an occurrence count,
    # not as one row per occurrence.
    para("说明：签字须双方完成——学生签字后交创新导师签字确认。"),
    para("本节为列表项，使用 List Paragraph 样式，不应被识别为标题。", "14"),
]

DOCUMENT = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    f'<w:document xmlns:w="{W}"><w:body>{"".join(BLOCKS)}</w:body></w:document>'
)


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    target = sys.argv[1]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", ROOT_RELS)
        archive.writestr("word/_rels/document.xml.rels", DOC_RELS)
        archive.writestr("word/document.xml", DOCUMENT)
        archive.writestr("word/styles.xml", STYLES)
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
