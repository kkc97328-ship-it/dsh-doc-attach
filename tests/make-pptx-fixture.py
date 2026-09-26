#!/usr/bin/env python3
"""Build a synthetic .pptx fixture for the presentation reader tests.

Usage: python make-pptx-fixture.py <output.pptx>

Why a generator: the fixture must contain no real content and must be
reviewable. Unlike the Word fixture this one is deliberately minimal — the
reader locates slides from the package's entry names and reads text runs, so
the package needs those parts and nothing more. It is a fixture for THIS
reader, not a fully valid PowerPoint package.

It does exercise the two shapes the reader distinguishes: a slide with a title
placeholder (which becomes an outline entry) and a slide without one (which
does not), plus a speaker-notes page.
"""
import sys
import zipfile

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"

CONTENT_TYPES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="{CT}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>"""


def run(text):
    return f'<a:r><a:t>{text}</a:t></a:r>'


def body_shape(paragraphs, placeholder=None):
    """One shape; `placeholder` makes it a title (or other) placeholder."""
    ph = f'<p:ph type="{placeholder}"/>' if placeholder else ""
    paras = "".join(f"<a:p>{run(text)}</a:p>" for text in paragraphs)
    return (
        f"<p:sp><p:nvSpPr><p:nvPr>{ph}</p:nvPr></p:nvSpPr>"
        f"<p:txBody><a:bodyPr/>{paras}</p:txBody></p:sp>"
    )


def slide(shapes):
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree>'
        f'{"".join(shapes)}'
        f"</p:spTree></p:cSld></p:sld>"
    )


SLIDES = {
    # A titled slide: the title must appear in the outline.
    "ppt/slides/slide1.xml": slide([
        body_shape(["测试演示文稿 2026"], placeholder="title"),
        body_shape(["本演示说明第一部分的要点。"]),
        body_shape(["要点一：标题所在形状应进入大纲。", "要点二：正文不应进入大纲。"]),
    ]),
    # A titled third slide, to prove ordering is numeric not lexical.
    "ppt/slides/slide2.xml": slide([
        body_shape(["第二部分 报名流程"], placeholder="title"),
        body_shape(["学生须在开学前两周提交申请材料。"]),
    ]),
    # An untitled slide: text is still readable, but adds no outline entry.
    "ppt/slides/slide3.xml": slide([
        body_shape(["此页没有标题占位符。", "它仍应作为一张幻灯片出现。"]),
    ]),
    "ppt/slides/slide10.xml": slide([
        body_shape(["第十张（用于验证按数字序而非字典序排列）"], placeholder="title"),
    ]),
    "ppt/notesSlides/notesSlide1.xml": slide([
        body_shape(["演讲者备注：提醒听众提交三方协议。"]),
    ]),
}


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    target = sys.argv[1]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        for name, payload in SLIDES.items():
            archive.writestr(name, payload)
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
