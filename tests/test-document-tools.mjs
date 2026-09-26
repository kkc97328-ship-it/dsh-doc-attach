/**
 * Verification for the host tools (document_outline / document_search / document_read).
 *
 * Run: node dsh-doc-attach/tests/test-document-tools.mjs
 *
 * Two things are being verified, and the second is the one that matters:
 *
 *  1. Tool wiring — each tool exposes a name, description, JSON schema and an
 *     executor, and `apply()` registers all three through the tools registry
 *     and disposes them through ctx.effect.
 *  2. The document-QA workflow the user actually asked for — given a question,
 *     outline -> search -> read must locate the passage that answers it. These
 *     checks assert on answer-bearing content, not just on "some text came
 *     back", because "reads the file" is not the requirement.
 *
 * Both formats are exercised: a 53-page PDF and a generated Word document.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { buildTools, apply, toAbsolute } from '../plugins/read-document.mjs'
import { PDF_FIXTURES, PYTHON, cleanUp, ensureDocxFixture, scratchDir, suite } from './fixture.mjs'

const SCRATCH = scratchDir('toolscratch')
const DOCX = ensureDocxFixture(SCRATCH)

const { check, finish } = suite('Document tool verification')
console.log(`pdf  : ${PDF_FIXTURES.paper} (exists=${existsSync(PDF_FIXTURES.paper)})`)
console.log(`docx : ${DOCX}`)
console.log('')

const tools = buildTools({
  pythonPath: PYTHON,
  cacheDir: SCRATCH,
  defaultWindow: 12,
  maxWindow: 40,
  maxBlockChars: 12000,
  defaultMaxHits: 20,
  timeoutMs: 60000,
})

// ── tool wiring ───────────────────────────────────────────────────────────
await check('all three tools expose registry-shaped definitions', async () => {
  for (const key of ['outline', 'search', 'read']) {
    const tool = tools[key]
    assert.equal(typeof tool.name, 'string', `${key}.name`)
    assert.ok(tool.description.length > 40, `${key}.description must teach usage`)
    assert.equal(tool.parameters.type, 'object', `${key}.parameters`)
    assert.equal(typeof tool.execute, 'function', `${key}.execute`)
    assert.equal(typeof tool.output.render, 'function', `${key}.output.render`)
    assert.equal(tool.output.render({}, 'hello')[0].text, 'hello', `${key}.render`)
  }
})

await check('apply() registers three tools and returns a disposer per tool', async () => {
  /** @type {string[]} */
  const registered = []
  let disposers = 0
  let effects = 0
  const ctx = {
    logger: { info() {} },
    effect(factory) {
      effects += 1
      const dispose = factory()
      if (typeof dispose === 'function') disposers += 1
      return dispose
    },
    tools: {
      register(tool) {
        registered.push(tool.name)
        return () => {}
      },
    },
  }
  apply(ctx, { pythonPath: PYTHON, cacheDir: SCRATCH })
  assert.deepEqual(registered.sort(), ['document_outline', 'document_read', 'document_search'])
  assert.equal(effects, 3, 'one effect per registered tool')
  assert.equal(disposers, 3, 'every registration returns a disposer')
})

// ── path handling ─────────────────────────────────────────────────────────
await check('a quoted path is unquoted rather than treated as literal', async () => {
  assert.equal(toAbsolute(`"${PDF_FIXTURES.paper}"`), PDF_FIXTURES.paper)
})

await check('a missing file yields an actionable sentence, not a stack trace', async () => {
  const out = await tools.read.execute({ path: 'D:\\nope\\missing.pdf' })
  assert.ok(out.includes('文件不存在'), out.slice(0, 120))
})

await check('a foreign container is refused by name, while .pptx is accepted', async () => {
  // Retargeted once PowerPoint became readable: the intent is that an
  // unsupported format is named rather than silently ignored, and that a
  // now-supported one is no longer refused.
  const foreign = await tools.read.execute({ path: join_(SCRATCH, 'book.xlsx') })
  assert.ok(foreign.includes('.xlsx'), `message should name the format: ${foreign.slice(0, 140)}`)
  assert.ok(foreign.includes('不支持'), foreign.slice(0, 140))
  const deck = await tools.read.execute({ path: join_(SCRATCH, 'deck.pptx') })
  assert.ok(!deck.includes('尚未实现') && !deck.includes('不支持'), deck.slice(0, 140))
})

await check('a plain-text extension points the agent at the read tool', async () => {
  const out = await tools.read.execute({ path: join_(SCRATCH, 'notes.txt') })
  assert.ok(out.includes('read 工具'), `expected a redirect to the plain reader: ${out.slice(0, 140)}`)
})

// ── PDF: the QA workflow ──────────────────────────────────────────────────
await check('outline describes the paper without returning body text', async () => {
  const out = await tools.outline.execute({ path: PDF_FIXTURES.paper })
  assert.ok(out.includes('共 53 页'), `expected 53 pages: ${out.slice(0, 200)}`)
  assert.ok(out.includes('document_search'), 'outline tells the agent what to do next')
})

await check('QA: locating a specific fact in a 53-page paper', async () => {
  // The question "how many parameters does DeepSeek-V3 have?" must be
  // answerable by locating the figure, not by reading all 53 pages.
  const hits = await tools.search.execute({ path: PDF_FIXTURES.paper, query: '671B', maxHits: 5 })
  assert.ok(hits.includes('命中'), `expected hits: ${hits.slice(0, 200)}`)
  assert.ok(/第 \d+ 页/.test(hits), 'hits are position-anchored')
  const page = Number(/第 (\d+) 页/.exec(hits)[1])
  const body = await tools.read.execute({ path: PDF_FIXTURES.paper, start: page, count: 1 })
  assert.ok(body.includes('671B'), 'the located page carries the answer-bearing figure')
  assert.ok(body.includes(`第 ${page} 页`), 'the read output is annotated for citation')
})

await check('QA: locating a clause in a CJK document', async () => {
  const hits = await tools.search.execute({ path: PDF_FIXTURES.cjk, query: '缴纳', maxHits: 5 })
  assert.ok(hits.includes('命中'), `expected CJK hits: ${hits.slice(0, 200)}`)
  const body = await tools.read.execute({ path: PDF_FIXTURES.cjk, start: 1, count: 1 })
  assert.ok(body.includes('缴纳'), 'page 1 carries the clause')
  assert.ok(body.includes('机构指定'), 'and the answer-bearing phrase survives extraction')
})

await check('QA: a regex query finds several phrasings of one concept', async () => {
  const hits = await tools.search.execute({ path: PDF_FIXTURES.paper, query: 'MoE|Mixture-of-Experts', regex: true, maxHits: 5 })
  assert.ok(hits.includes('命中'), `expected regex hits: ${hits.slice(0, 200)}`)
})

await check('search reports a miss with guidance instead of failing', async () => {
  const out = await tools.search.execute({ path: PDF_FIXTURES.paper, query: 'zzzz-absent-zzzz' })
  assert.ok(out.includes('无命中'), out.slice(0, 160))
  assert.ok(out.includes('建议'), 'a miss tells the agent how to retry usefully')
})

await check('read annotates every returned page and reports position', async () => {
  const out = await tools.read.execute({ path: PDF_FIXTURES.paper, start: 7, count: 3 })
  for (const page of [7, 8, 9]) assert.ok(out.includes(`—— 第 ${page} 页 ——`), `page ${page} marker`)
  assert.ok(out.includes('共 53 页'), 'reports document extent')
})

await check('read clamps count to maxWindow instead of over-reading', async () => {
  const out = await tools.read.execute({ path: PDF_FIXTURES.paper, start: 1, count: 9999 })
  assert.ok(out.includes('第 40 页'), 'reads up to the ceiling')
  assert.ok(!out.includes('第 41 页'), 'and stops there')
})

// ── Word: the QA workflow ─────────────────────────────────────────────────
await check('outline shows the heading outline for a Word document', async () => {
  const out = await tools.outline.execute({ path: DOCX })
  assert.ok(out.includes('共 ') && out.includes('块'), `expected a block count: ${out.slice(0, 160)}`)
  assert.ok(out.includes('标题大纲'), 'a Word outline must surface its headings')
  assert.ok(out.includes('测试方案 2026'), 'the title heading appears')
  assert.ok(out.includes('第二节 材料清单'), 'deeper headings appear too')
})

await check('QA on Word: locate a clause by search, then read the located block', async () => {
  // The question "材料清单要求什么?" must be answered from the section that
  // carries it, reached through search rather than by reading the document.
  const hits = await tools.search.execute({ path: DOCX, query: '三方协议', maxHits: 5 })
  assert.ok(hits.includes('命中'), `expected hits: ${hits.slice(0, 200)}`)
  assert.ok(hits.includes('所属标题：第二节 材料清单'), `expected heading context: ${hits.slice(0, 300)}`)
  const block = Number(/第 (\d+) 块/.exec(hits)[1])
  const body = await tools.read.execute({ path: DOCX, start: block, count: 1 })
  assert.ok(body.includes('三方协议'), 'the located block carries the answer')
  assert.ok(body.includes(`第 ${block} 块`), 'and it is annotated for citation')
})

await check('Word read marks headings and table rows distinctly', async () => {
  const out = await tools.read.execute({ path: DOCX, start: 1, count: 30 })
  assert.ok(out.includes('【标题 L1】'), 'a level-1 heading is marked')
  assert.ok(out.includes('【标题 L2】'), 'a level-2 heading is marked')
  assert.ok(out.includes('【表格行】'), 'a table row is marked as such')
  assert.ok(out.includes('共 ') && out.includes('块'), 'reports the document extent in blocks')
})

await check('a Word miss also carries guidance', async () => {
  const out = await tools.search.execute({ path: DOCX, query: 'zzzz-absent-zzzz' })
  assert.ok(out.includes('无命中'), out.slice(0, 160))
  assert.ok(out.includes('建议'), out.slice(0, 200))
})

/** Local join, so the suite needs no extra import for two call sites. */
function join_(dir, name) {
  return `${dir}\\${name}`
}

cleanUp(SCRATCH)
finish()
