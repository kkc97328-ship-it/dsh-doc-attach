/**
 * Verification for legacy .doc support.
 *
 * Run: node dsh-doc-attach/tests/test-doc-format.mjs
 *
 * `.doc` is OLE2/CFB rather than OOXML, so it goes through its own reader and
 * deserves its own checks. It also has a real fixture problem: a .doc cannot be
 * GENERATED on this machine — Word COM automation hangs without an interactive
 * desktop, and antiword/LibreOffice every Python .doc library are absent — so
 * the suite uses whatever real .doc files it can find and skips honestly when
 * there are none, rather than asserting against a fixture it invented.
 *
 * Candidate order:
 *   1. $DSH_DOC_FIXTURE, for a richer local document
 *   2. the Office-shipped template, which is real, small, and not personal
 *
 * Known coverage gap, stated rather than hidden: every real .doc available here
 * stores text as UTF-16 pieces (Chinese documents cannot produce Word's 8-bit
 * "compressed" pieces), so that decode branch is exercised only by the reader's
 * own unit path, not by an end-to-end document.
 */
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DocumentExtractionError, PythonDocumentBackend } from '../lib/extract/document-python.mjs'
import { buildTools } from '../plugins/read-document.mjs'
import { PYTHON, cleanUp, scratchDir, suite } from './fixture.mjs'

const SCRATCH = scratchDir('docfmt')

/** Real .doc files to try, best first. None is personal content. */
const CANDIDATES = [
  process.env.DSH_DOC_FIXTURE,
  'C:\\Program Files\\Microsoft Office\\root\\Office16\\2052\\PROTTPLN.DOC',
  'C:\\Program Files\\Microsoft Office\\root\\Office16\\2052\\PROTTPLV.DOC',
  'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\2052\\PROTTPLN.DOC',
].filter(candidate => typeof candidate === 'string' && candidate !== '')

const DOC = CANDIDATES.find(candidate => existsSync(candidate))
if (DOC === undefined) {
  console.log('legacy .doc verification: SKIPPED — no .doc fixture found.')
  console.log(`  set DSH_DOC_FIXTURE to a real .doc to run this suite. Tried: ${CANDIDATES.join(', ')}`)
  cleanUp(SCRATCH)
  process.exit(0)
}

const { check, finish } = suite('Legacy .doc verification')
console.log(`fixture: ${DOC}`)
console.log('')

function backend(options = {}) {
  return new PythonDocumentBackend({ pythonPath: PYTHON, cacheDir: SCRATCH, ...options })
}

const tools = buildTools({
  pythonPath: PYTHON,
  cacheDir: SCRATCH,
  defaultWindow: 12,
  maxWindow: 120,
  maxBlockChars: 12000,
  defaultMaxHits: 20,
  timeoutMs: 60000,
})

/**
 * A search term guaranteed to be present: the first real character of the
 * document itself.
 *
 * An earlier version searched for "e" on the theory that any non-empty
 * document contains it. That held for the English Office template and failed
 * for a pure-Chinese form with no Latin characters at all — a test assumption
 * about language, not a defect in the reader.
 */
async function selfTerm() {
  const window = await backend().extract(DOC, { start: 1, count: 1 })
  const text = window.blocks.map(block => block.text.trim()).find(line => line.length > 0) ?? ''
  const char = [...text].find(ch => !/\s/.test(ch))
  assert.ok(char !== undefined, 'the fixture must yield at least one character to search for')
  return char
}

// ── backend ───────────────────────────────────────────────────────────────
await check('.doc stats reports format=doc with block units', async () => {
  const stats = await backend().stats(DOC)
  assert.equal(stats.format, 'doc')
  assert.equal(stats.unit, 'block', 'a .doc has no fixed pages, so its unit is a block')
  assert.ok(stats.blockCount > 0, 'the document yields at least one block')
  assert.equal(stats.textLayer, true)
})

await check('.doc extract returns blocks with readable text', async () => {
  const window = await backend().extract(DOC, { start: 1, count: 5 })
  assert.ok(window.blocks.length > 0, 'a window comes back')
  assert.ok(
    window.blocks.some(block => block.text.trim().length > 0),
    'at least one block carries text',
  )
  assert.ok(window.blocks.every(block => typeof block.index === 'number'), 'blocks are indexed')
})

await check('.doc search anchors hits to blocks', async () => {
  const term = await selfTerm()
  const result = await backend().search(DOC, { query: term, maxHits: 3 })
  assert.ok(result.hitCount >= 1, `expected at least one hit for "${term}"`)
  assert.ok(result.hits.every(hit => hit.block >= 1), 'hits carry block numbers')
})

// ── tool layer ────────────────────────────────────────────────────────────
await check('the tool layer accepts .doc instead of refusing it', async () => {
  const out = await tools.read.execute({ path: DOC, start: 1, count: 1 })
  assert.ok(!out.includes('不支持'), `a .doc must not be refused: ${out.slice(0, 160)}`)
  assert.ok(out.includes('块'), `positions are reported in blocks: ${out.slice(0, 160)}`)
})

await check('outline describes a .doc in blocks', async () => {
  const out = await tools.outline.execute({ path: DOC })
  assert.ok(out.includes('共 '), `expected a scale line: ${out.slice(0, 160)}`)
  assert.ok(out.includes('块'), 'a .doc is measured in blocks')
})

await check('search then read works on a .doc', async () => {
  const term = await selfTerm()
  const hits = await tools.search.execute({ path: DOC, query: term, maxHits: 3 })
  assert.ok(hits.includes('命中'), `expected hits: ${hits.slice(0, 200)}`)
  const block = Number(/第 (\d+) 块/.exec(hits)[1])
  const body = await tools.read.execute({ path: DOC, start: block, count: 1 })
  assert.ok(body.includes(`第 ${block} 块`), 'the located block can be read back and cited')
})

// ── failure modes ─────────────────────────────────────────────────────────
await check('a file that is not a CFB container rejects as UNREADABLE', async () => {
  const fake = join(SCRATCH, 'not-really.doc')
  writeFileSync(fake, 'plain text wearing a .doc extension')
  await assert.rejects(
    () => backend().extract(fake, { start: 1, count: 1 }),
    (error) => error instanceof DocumentExtractionError && error.code === 'UNREADABLE',
  )
})

await check('.pptx is no longer refused, and a foreign container still is', async () => {
  // This check used to assert that .pptx was refused as unimplemented. It is
  // now readable, so the assertion moved to the format that genuinely has no
  // reader — keeping the original intent (a refusal must name the format and
  // say it is unsupported) while tracking what the plugin actually supports.
  const deck = await tools.read.execute({ path: join(SCRATCH, 'deck.pptx') })
  assert.ok(
    !deck.includes('尚未实现') && !deck.includes('不支持'),
    `PowerPoint must no longer be refused: ${deck.slice(0, 140)}`,
  )
  const foreign = await tools.read.execute({ path: join(SCRATCH, 'book.xlsx') })
  assert.ok(foreign.includes('.xlsx'), `message should name the format: ${foreign.slice(0, 140)}`)
  assert.ok(foreign.includes('不支持'), foreign.slice(0, 140))
})

await check('a legacy .doc the reader cannot parse reports its own code', async () => {
  await assert.rejects(
    () => backend().stats(join(SCRATCH, 'missing.doc')),
    (error) => error instanceof DocumentExtractionError
      && (error.code === 'NOT_FOUND' || error.code === 'UNREADABLE'),
  )
})

cleanUp(SCRATCH)
finish()
