/**
 * Verification for the document backend (stats / search / extract).
 *
 * Run: node dsh-doc-attach/tests/test-document-backend.mjs
 *
 * Exercises the real interpreter against real documents, because the whole
 * point of this backend is that the environment has no JS document parser and
 * no reachable module registry.
 *
 * Two formats are covered against one block model: a PDF, where a block is a
 * page, and a generated Word document, where a block is a paragraph, a heading,
 * or one table row. The Word checks include an explicit regression guard for
 * numeric style ids — the shape that made a real document's outline come back
 * empty.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DocumentExtractionError, PythonDocumentBackend } from '../lib/extract/document-python.mjs'
import { PDF_FIXTURES, PYTHON, cleanUp, ensureDocxFixture, scratchDir, suite } from './fixture.mjs'

const CACHE = scratchDir('cache')
const SCRATCH = scratchDir('scratch')
const DOCX = ensureDocxFixture(SCRATCH)

const { check, finish } = suite('Document backend verification')
console.log(`interpreter: ${PYTHON} (exists=${existsSync(PYTHON)})`)
console.log(`pdf cjk    : ${PDF_FIXTURES.cjk} (exists=${existsSync(PDF_FIXTURES.cjk)})`)
console.log(`pdf paper  : ${PDF_FIXTURES.paper} (exists=${existsSync(PDF_FIXTURES.paper)})`)
console.log(`docx       : ${DOCX}`)
console.log('')

/** Fresh backend per check keeps memoized probe state from leaking. */
function backend(options = {}) {
  return new PythonDocumentBackend({ pythonPath: PYTHON, cacheDir: CACHE, ...options })
}

// ── capability ────────────────────────────────────────────────────────────
await check('probe resolves with a working interpreter', async () => {
  await backend().probe()
})

// ── PDF: the page-per-block path ──────────────────────────────────────────
await check('stats outlines a long paper without dumping its text', async () => {
  const stats = await backend().stats(PDF_FIXTURES.paper)
  assert.equal(stats.format, 'pdf')
  assert.equal(stats.unit, 'page')
  assert.equal(stats.blockCount, 53, `expected 53 pages, got ${stats.blockCount}`)
  assert.equal(stats.textLayer, true)
  assert.ok(stats.totalChars > 50_000, `expected substantial text, got ${stats.totalChars}`)
  assert.equal(stats.emptyBlocks.length, 0, 'this paper has no blank pages')
})

await check('stats reports per-block sizes for a short CJK document', async () => {
  const stats = await backend().stats(PDF_FIXTURES.cjk)
  assert.equal(stats.blockCount, 2)
  assert.ok(stats.totalChars > 500, `expected CJK text, got ${stats.totalChars}`)
  assert.equal(stats.emptyBlocks.length, 0, 'neither page should be empty')
})

await check('extract returns a CJK text layer without mojibake', async () => {
  const result = await backend().extract(PDF_FIXTURES.cjk, { start: 1, count: 2 })
  const text = result.blocks.map(block => block.text).join('\n')
  const cjk = [...text].filter(ch => ch >= '\u4e00' && ch <= '\u9fff').length
  assert.ok(cjk > 50, `expected CJK codepoints, found ${cjk}`)
  assert.equal((text.match(/\ufffd/g) ?? []).length, 0, 'no replacement characters')
})

await check('extract honours a mid-document window and reports hasMore', async () => {
  const result = await backend().extract(PDF_FIXTURES.paper, { start: 10, count: 2 })
  assert.deepEqual(result.blocks.map(block => block.index), [10, 11])
  assert.equal(result.hasMore, true)
})

await check('a window past the last block clamps instead of failing', async () => {
  const result = await backend().extract(PDF_FIXTURES.cjk, { start: 2, count: 5 })
  assert.equal(result.end, 2, 'end must clamp to the last block')
  assert.equal(result.hasMore, false)
})

await check('search anchors an English hit to its block', async () => {
  const result = await backend().search(PDF_FIXTURES.paper, { query: 'DeepSeek-V3', maxHits: 5 })
  assert.ok(result.hitCount > 0, 'expected at least one hit')
  assert.equal(result.hits[0].block, 1, 'the title hit belongs to page 1')
  assert.ok(result.hits[0].snippet.includes('DeepSeek-V3'), 'snippet contains the match')
})

await check('search works on CJK text', async () => {
  const result = await backend().search(PDF_FIXTURES.cjk, { query: '收费', maxHits: 10 })
  assert.ok(result.hitCount > 0, 'expected CJK hits')
  assert.ok(result.hits.every(hit => hit.block >= 1 && hit.block <= 2), 'hits carry valid blocks')
})

await check('search accepts a regular expression', async () => {
  const result = await backend().search(PDF_FIXTURES.paper, {
    query: 'MoE|Mixture-of-Experts', regex: true, maxHits: 20,
  })
  assert.ok(result.hitCount > 0, 'expected regex hits')
  assert.equal(result.regex, true)
})

await check('search reports a miss as zero hits, not an error', async () => {
  const result = await backend().search(PDF_FIXTURES.paper, { query: 'zzzz-not-in-this-document-zzzz' })
  assert.equal(result.hitCount, 0)
  assert.equal(result.truncated, false)
})

await check('search truncates at maxHits instead of returning everything', async () => {
  const result = await backend().search(PDF_FIXTURES.paper, { query: 'the', maxHits: 3 })
  assert.equal(result.hitCount, 3, 'respects the ceiling')
  assert.equal(result.truncated, true, 'and says more were found')
})

await check('search rejects an empty query', async () => {
  await assert.rejects(
    () => backend().search(PDF_FIXTURES.paper, { query: '' }),
    (error) => error instanceof DocumentExtractionError && error.code === 'BAD_QUERY',
  )
})

await check('repeated access reuses a cache entry', async () => {
  const instance = backend()
  await instance.search(PDF_FIXTURES.paper, { query: 'DeepSeek', maxHits: 2 })
  const entries = readdirSync(CACHE).filter(name => name.endsWith('.json'))
  assert.ok(entries.length >= 1, `expected a cache file, found ${entries.length}`)
})

// ── Word: the paragraph/heading/table-row path ────────────────────────────
await check('DOCX stats reports the format, the unit, and a heading outline', async () => {
  const stats = await backend().stats(DOCX)
  assert.equal(stats.format, 'docx')
  assert.equal(stats.unit, 'block')
  assert.ok(stats.blockCount > 8, `expected several blocks, got ${stats.blockCount}`)
  assert.equal(stats.textLayer, true)
  assert.equal(stats.outline.length, 3, `expected 3 headings, got ${stats.outline.length}`)
  assert.equal(stats.outline[0].text, '测试方案 2026')
  assert.equal(stats.outline[0].level, 1)
})

await check('DOCX heading ids resolve through styles.xml, not by id text', async () => {
  // Regression guard. The fixture's style ids are bare numbers ("2" → name
  // "heading 1", "3" → name "heading 2"), which is exactly how a real Word
  // document defeated a detector that matched the id itself: the outline came
  // back empty while the headings were plainly there.
  const stats = await backend().stats(DOCX)
  assert.deepEqual(stats.outline.map(row => row.level), [1, 2, 2], 'H1 then two H2s')
  assert.equal(stats.outline[1].text, '第一节 报名流程')
  assert.equal(stats.outline[2].text, '第二节 材料清单')
})

await check('DOCX: a List Paragraph style is not treated as a heading', async () => {
  const stats = await backend().stats(DOCX)
  assert.ok(
    !stats.outline.some(row => row.text.includes('列表项')),
    'a list paragraph must not enter the heading outline',
  )
})

await check('DOCX extract yields headings, paragraphs and table rows in order', async () => {
  const result = await backend().extract(DOCX, { start: 1, count: 30 })
  const kinds = new Set(result.blocks.map(block => block.kind))
  assert.ok(kinds.has('heading'), 'headings are present')
  assert.ok(kinds.has('paragraph'), 'paragraphs are present')
  assert.ok(kinds.has('table'), 'table rows are present')
  assert.equal(result.blocks[0].kind, 'heading', 'the title comes first')
  assert.ok(result.blocks[0].index < result.blocks.at(-1).index, 'blocks are in document order')
})

await check('DOCX table rows are searchable individually', async () => {
  const result = await backend().search(DOCX, { query: '报名方式', maxHits: 5 })
  assert.equal(result.hitCount, 1, 'the row that carries the label is found once')
  assert.equal(result.hits[0].kind, 'table')
  assert.ok(result.hits[0].snippet.includes('统一报给班长'), 'the whole row is the snippet')
})

await check('DOCX search reports the enclosing heading', async () => {
  const result = await backend().search(DOCX, { query: '三方协议', maxHits: 5 })
  assert.equal(result.hitCount, 1)
  assert.equal(result.hits[0].heading, '第二节 材料清单', 'the hit is placed under its section')
})

await check('DOCX search returns one hit per block, with an occurrence count', async () => {
  const result = await backend().search(DOCX, { query: '签字', maxHits: 20 })
  const blocks = result.hits.map(hit => hit.block)
  assert.equal(new Set(blocks).size, blocks.length, 'no block appears twice')
  assert.ok(result.hits.every(hit => hit.occurrences >= 1), 'every hit counts its occurrences')
  assert.ok(result.hits.some(hit => hit.occurrences > 1), 'the repeated term is counted, not repeated as rows')
})

// ── failure modes shared by both formats ──────────────────────────────────
await check('missing file rejects with NOT_FOUND', async () => {
  await assert.rejects(
    () => backend().extract('D:\\nope\\missing.pdf', { start: 1, count: 1 }),
    (error) => error instanceof DocumentExtractionError && error.code === 'NOT_FOUND',
  )
})

await check('a non-document rejects as UNREADABLE, not empty text', async () => {
  await assert.rejects(
    () => backend().extract('D:\\dsh_workplace\\docs\\document-attachment-plugin-plan.md', { start: 1, count: 1 }),
    (error) => error instanceof DocumentExtractionError
      && (error.code === 'UNREADABLE' || error.code === 'UNSUPPORTED_FORMAT' || error.code === 'EXTRACTION_FAILED'),
  )
})

await check('a .docx that is not a zip rejects as UNREADABLE', async () => {
  const fake = join(SCRATCH, 'not-really.docx')
  writeFileSync(fake, 'this is plain text wearing a docx extension')
  await assert.rejects(
    () => backend().extract(fake, { start: 1, count: 1 }),
    (error) => error instanceof DocumentExtractionError && error.code === 'UNREADABLE',
  )
})

await check('a container with no reader rejects with UNSUPPORTED_FORMAT', async () => {
  // Retargeted from .pptx, which now HAS a reader, to a format the backend
  // genuinely does not handle — the assertion is about the error code the
  // loader returns for an unknown container, not about PowerPoint.
  await assert.rejects(
    () => backend().stats(join(SCRATCH, 'sheet.xlsx')),
    (error) => error instanceof DocumentExtractionError && error.code === 'UNSUPPORTED_FORMAT',
  )
})

await check('an out-of-range window rejects with BAD_RANGE', async () => {
  await assert.rejects(
    () => backend().extract(PDF_FIXTURES.cjk, { start: 0, count: 1 }),
    (error) => error instanceof DocumentExtractionError && error.code === 'BAD_RANGE',
  )
})

await check('an unusable interpreter rejects with BACKEND_UNAVAILABLE', async () => {
  const missing = new PythonDocumentBackend({ pythonPath: 'D:\\workspace\\definitely-not-python.exe' })
  await assert.rejects(
    () => missing.probe(),
    (error) => error instanceof DocumentExtractionError && error.code === 'BACKEND_UNAVAILABLE',
  )
})

cleanUp(CACHE)
cleanUp(SCRATCH)
finish()
