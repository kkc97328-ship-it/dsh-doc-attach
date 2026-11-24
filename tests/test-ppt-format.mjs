/**
 * Verification for PowerPoint support: `.pptx` (OOXML) and legacy `.ppt` (binary).
 *
 * Run: node dsh-doc-attach/tests/test-ppt-format.mjs
 *
 * Both fixtures are GENERATED, so neither carries real content and both are
 * reviewable: `make-pptx-fixture.py` writes the OOXML package, and
 * `make-ppt-fixture.py` writes the CFB container and the record tree by hand
 * (see `cfb_writer.py`). The legacy half therefore runs everywhere instead of
 * skipping, and its three text containers make the Escher-61453 boundary rule
 * load-bearing — a reader grouping by `SlideListWithText` would return one block.
 *
 * A real PowerPoint-produced `.ppt` is still checked when one is present; that
 * check reports SKIP on a machine without Office. Set `DSH_PPT_FIXTURE` for a
 * richer local deck.
 */
import assert from 'node:assert/strict'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DocumentExtractionError, PythonDocumentBackend } from '../lib/extract/document-python.mjs'
import { buildTools } from '../plugins/read-document.mjs'
import { FIXTURE_MISSING, PYTHON, cleanUp, ensurePptFixture, scratchDir, suite } from './fixture.mjs'

const SCRATCH = scratchDir('pptfmt')
const GENERATOR = fileURLToPath(new URL('./make-pptx-fixture.py', import.meta.url))

/** Build the synthetic deck once and return its path. */
function ensurePptx() {
  const target = join(SCRATCH, 'fixture.pptx')
  const result = spawnSync(PYTHON, [GENERATOR, target], { stdio: 'ignore', windowsHide: true })
  if (result.error !== undefined) throw new Error(`generator failed to run: ${result.error.message}`)
  if (!existsSync(target) || statSync(target).size === 0) {
    throw new Error(`generator produced no file (exit ${result.status})`)
  }
  return target
}

const PPTX = ensurePptx()

/** The generated deck; deterministic and covered on every machine. */
const GENERATED_PPT = ensurePptFixture(SCRATCH)

/** A real PowerPoint-produced deck, when this machine happens to have Office. */
const REAL_PPT = [
  'C:\\Program Files\\Microsoft Office\\root\\Office16\\2052\\PROTTPLN.PPT',
  'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\2052\\PROTTPLN.PPT',
].find(candidate => existsSync(candidate))

/** A richer local deck may still be supplied for a deeper run. */
const LEGACY = process.env.DSH_PPT_FIXTURE ?? GENERATED_PPT

const { check, finish } = suite('PowerPoint verification')
console.log(`pptx fixture : ${PPTX}`)
console.log(`ppt fixture  : ${LEGACY}`)
console.log(`ppt (real)   : ${REAL_PPT ?? '(no Office template — that check will SKIP)'}`)
console.log('')

function backend(options = {}) {
  return new PythonDocumentBackend({ pythonPath: PYTHON, cacheDir: SCRATCH, ...options })
}

const tools = buildTools({
  pythonPath: PYTHON, cacheDir: SCRATCH, defaultWindow: 12, maxWindow: 120,
  maxBlockChars: 12000, defaultMaxHits: 20, timeoutMs: 60000,
})

// ── .pptx ─────────────────────────────────────────────────────────────────
await check('.pptx stats reports one block per slide, in slide units', async () => {
  const stats = await backend().stats(PPTX)
  assert.equal(stats.format, 'pptx')
  assert.equal(stats.unit, 'slide')
  assert.equal(stats.blockCount, 5, 'four slides plus one notes page')
  assert.equal(stats.textLayer, true)
})

await check('.pptx slides are ordered numerically, not lexically', async () => {
  // slide10 must sort after slide3, which a lexical sort gets wrong.
  const window = await backend().extract(PPTX, { start: 1, count: 5 })
  assert.deepEqual(window.blocks.map(block => block.slide), [1, 2, 3, 10, 1])
})

await check('.pptx outline carries the titled slides only', async () => {
  const stats = await backend().stats(PPTX)
  assert.equal(stats.outline.length, 3, 'three of the four slides have a title placeholder')
  assert.equal(stats.outline[0].text, '测试演示文稿 2026')
  assert.equal(stats.outline[2].text, '第十张（用于验证按数字序而非字典序排列）')
})

await check('.pptx extract returns title and body text per slide', async () => {
  const window = await backend().extract(PPTX, { start: 1, count: 1 })
  const text = window.blocks[0].text
  assert.ok(text.includes('测试演示文稿 2026'), 'the title is present')
  assert.ok(text.includes('要点一'), 'body text is present')
})

await check('.pptx search anchors a hit to its slide and names the section', async () => {
  const result = await backend().search(PPTX, { query: '三方协议', maxHits: 5 })
  assert.ok(result.hitCount >= 1, 'the notes page mentions 三方协议')
  assert.ok(result.hits.every(hit => hit.block >= 1), 'hits carry block numbers')
})

// ── tool layer ────────────────────────────────────────────────────────────
await check('the tool layer reads a .pptx and reports slides', async () => {
  const out = await tools.outline.execute({ path: PPTX })
  assert.ok(out.includes('页'), `positions are reported in slides: ${out.slice(0, 160)}`)
  assert.ok(out.includes('标题大纲'), 'a titled deck surfaces an outline')
  assert.ok(out.includes('测试演示文稿 2026'), 'the first title appears')
})

await check('a .pptx is not refused by name any more', async () => {
  const out = await tools.read.execute({ path: PPTX, start: 1, count: 2 })
  assert.ok(!out.includes('尚未实现'), `PowerPoint must no longer be refused: ${out.slice(0, 160)}`)
  assert.ok(!out.includes('不支持'), out.slice(0, 160))
})

// ── legacy .ppt ───────────────────────────────────────────────────────────
await check('legacy .ppt stats reports the format and block units', async () => {
  const stats = await backend().stats(LEGACY)
  assert.equal(stats.format, 'ppt')
  assert.equal(stats.unit, 'block', 'a legacy deck exposes no reliable slide number')
  assert.ok(stats.blockCount > 0)
  assert.equal(stats.textLayer, true)
})

await check('legacy .ppt yields one block per Escher text container', async () => {
  const window = await backend().extract(LEGACY, { start: 1, count: 10 })
  // The generated deck holds three text containers. A reader grouping by
  // SlideListWithText instead of the 61453 container would collapse this into a
  // single block of master text — the exact bug this reader was fixed for — so
  // the count is the regression guard, not decoration.
  assert.equal(window.blockCount, 3, `expected 3 text containers, got ${window.blockCount}`)
  assert.equal(window.blocks.length, 3)
  assert.ok(window.blocks.every(block => block.text.trim().length > 0))
})

await check('legacy .ppt is accepted by the tool layer', async () => {
  const out = await tools.read.execute({ path: LEGACY, start: 1, count: 2 })
  assert.ok(!out.includes('尚未实现') && !out.includes('不支持'), out.slice(0, 160))
  assert.ok(out.includes('块'), `a legacy deck is measured in blocks: ${out.slice(0, 160)}`)
})

await check('a real PowerPoint-produced .ppt also parses', async () => {
  if (REAL_PPT === undefined) {
    throw Object.assign(
      new Error('no Office .ppt template here — set DSH_PPT_FIXTURE to a real deck'),
      { code: FIXTURE_MISSING },
    )
  }
  const stats = await backend().stats(REAL_PPT)
  assert.equal(stats.format, 'ppt')
  assert.equal(stats.textLayer, true)
})

// ── failure modes ─────────────────────────────────────────────────────────
await check('a .pptx that is not a zip rejects as UNREADABLE', async () => {
  const fake = join(SCRATCH, 'not-really.pptx')
  writeFileSync(fake, 'plain text wearing a .pptx extension')
  await assert.rejects(
    () => backend().extract(fake, { start: 1, count: 1 }),
    (error) => error instanceof DocumentExtractionError && error.code === 'UNREADABLE',
  )
})

await check('a .ppt that is not a CFB container rejects as UNREADABLE', async () => {
  const fake = join(SCRATCH, 'not-really.ppt')
  writeFileSync(fake, 'plain text wearing a .ppt extension')
  await assert.rejects(
    () => backend().extract(fake, { start: 1, count: 1 }),
    (error) => error instanceof DocumentExtractionError
      && (error.code === 'UNREADABLE' || error.code === 'NOT_FOUND'),
  )
})

cleanUp(SCRATCH)
finish()
