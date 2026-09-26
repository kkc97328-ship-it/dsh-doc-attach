/**
 * dsh-doc-attach host half — document retrieval tools for the agent.
 *
 * The goal is not "print the file". A 53-page paper or a 267-block Word
 * document must never be dumped into the context: it is expensive, and it
 * buries the answer. Instead this plugin gives the agent the three retrieval
 * primitives a document-QA workflow needs, and the tool descriptions teach the
 * workflow explicitly:
 *
 *   document_outline  see the whole document cheaply and decide where to look
 *   document_search   locate the passages a question is about, with block
 *                     numbers and the enclosing heading
 *   document_read     read one window of blocks precisely
 *
 * The agent composes them and produces the answer with citations. This plugin
 * never summarises or interprets content; understanding and organising the
 * answer is the model's job, and doing it on retrieved excerpts is what keeps
 * the result both accurate and cheap.
 *
 * One unit concept spans both formats: a **block**. For a PDF a block is a
 * page; for a Word document it is a paragraph, a heading, or one table row.
 * The tool text says which, so the agent never has to guess what "block 12"
 * means for the file it is holding.
 *
 * Zero non-builtin dependencies: the backend is a subprocess bridge to the
 * machine's Python, which supplies PyPDF2 for PDF and the standard library's
 * `zipfile` for Word — this deployment has no reachable module registry and no
 * JS document parser.
 */
import { existsSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { PythonDocumentBackend } from '../lib/extract/document-python.mjs'

export const name = 'dsh-doc-attach'
/** The tools registry is the only service this plugin consumes. */
export const inject = ['tools']

/**
 * Containers this build can read.
 *
 * Kept in step with `drop-ingest.mjs`'s `extensions` and the browser bundle's
 * `ACCEPTED` list by `tests/test-extension-consistency.mjs`: three copies of
 * one fact drifted apart once already, and a `.doc` the tools could read was
 * still refused at the drop target.
 */
const READABLE = new Set(['.pdf', '.docx', '.doc', '.pptx', '.ppt'])
/** Containers this plugin will never handle. */
const FOREIGN = new Set(['.xls', '.xlsx', '.odt', '.rtf', '.txt', '.md'])

const DEFAULT_CONFIG = {
  /** Interpreter that can run document_helper.py; discovery runs when unset. */
  pythonPath: undefined,
  /** Block cache directory; '' disables caching. */
  cacheDir: undefined,
  /** Blocks returned by document_read when the caller does not say. */
  defaultWindow: 12,
  /** Largest window a single document_read may return. */
  maxWindow: 120,
  /** Per-block character ceiling before a block is truncated with a notice. */
  maxBlockChars: 12000,
  /** Hits returned by document_search when the caller does not say. */
  defaultMaxHits: 20,
  /** Subprocess budget per invocation. */
  timeoutMs: 60000,
}

/**
 * What one block means, keyed by the backend's `unit` value.
 *
 * The key must be the UNIT ('page'/'block'/'slide'), not the format: keying it
 * by format silently degraded every PDF to the fallback word, which is how a
 * 53-page paper came to be described as "53 块".
 */
const UNIT_WORD = { page: '页', block: '块', slide: '页' }

/** Human-readable byte size. */
function humanSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

/**
 * Resolve one caller-supplied path to an absolute path this process can read.
 * @param {string} raw - path as the caller wrote it.
 * @returns {string} absolute path.
 */
function toAbsolute(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return text
  // Strip the quoting a Windows drag-and-drop or shell paste often adds.
  const unquoted = text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
  return isAbsolute(unquoted) ? unquoted : resolve(process.cwd(), unquoted)
}

/**
 * Validate a path before handing it to the backend, so the agent gets an
 * actionable sentence instead of a subprocess error code.
 * @returns {string | null} a problem description, or null when usable.
 */
function describePathProblem(abs) {
  if (abs === '') return '路径为空。请传入文档的绝对路径。'
  const ext = extname(abs).toLowerCase()
  if (READABLE.has(ext)) {
    if (!existsSync(abs)) return `文件不存在：${abs}`
    return null
  }
  if (FOREIGN.has(ext)) {
    return `不支持的格式 ${ext}：本工具只读 PDF、Word 与 PowerPoint。纯文本文件请直接用 read 工具，图片请直接拖入（走图片通道）。`
  }
  return `不支持的扩展名“${ext || '(无)'}”；本工具只读 PDF、Word 与 PowerPoint。`
}

/**
 * Build one tools-registry entry set for a config.
 * @param {object} cfg - resolved configuration.
 * @returns {{ outline: object, search: object, read: object, backend: PythonDocumentBackend }} tools and backend.
 */
function buildTools(cfg) {
  const backend = new PythonDocumentBackend({
    pythonPath: cfg.pythonPath,
    cacheDir: cfg.cacheDir,
    timeoutMs: cfg.timeoutMs,
  })

  /**
   * Run a backend call, translating a typed backend failure into a sentence
   * the agent can act on rather than a stack trace.
   * @param {() => Promise<any>} run - the backend call.
   * @returns {Promise<{ value: any } | { problem: string }>} one of the two.
   */
  async function attempt(run) {
    try {
      return { value: await run() }
    } catch (error) {
      const code = error && error.code ? error.code : 'EXTRACTION_FAILED'
      const message = error && error.message ? error.message : String(error)
      if (code === 'BACKEND_UNAVAILABLE') {
        return { problem: `文档解析后端不可用：${message}\n提示：设置 config.pythonPath 或环境变量 DSH_DOC_PYTHON 指向可用的解释器。` }
      }
      if (code === 'NO_TEXT_LAYER') {
        return { problem: `${message}\n这份文档没有可抽取的文本层（通常是扫描件或纯图片 PDF）。当前版本不做 OCR，因此无法读取其内容。` }
      }
      if (code === 'EMPTY_DOCUMENT') {
        return { problem: `${message}\n文档能打开，但正文里没有可读内容（可能全在文本框或图片中）。` }
      }
      return { problem: `读取失败（${code}）：${message}` }
    }
  }

  /** Words for one block, per format. */
  const unitOf = result => UNIT_WORD[result.unit] ?? '块'

  const pathParams = {
    path: { type: 'string', description: '文档的绝对路径（也接受相对当前工作目录的路径）。支持 PDF 与 Word(.docx)。' },
  }

  const outline = {
    name: 'document_outline',
    description: '先看文档的全貌，再决定读哪里——不返回正文，只返回规模（PDF 按页、Word 按段/标题/表格行）、总字符数，以及 Word 的标题大纲。回答任何关于文档的问题前，先用它建立全局认知；标题大纲对长文档尤其有用，能直接看出内容分几部分、各在第几块。',
    parameters: { type: 'object', properties: { ...pathParams }, required: ['path'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const abs = toAbsolute(args.path)
      const problem = describePathProblem(abs)
      if (problem !== null) return problem
      const got = await attempt(() => backend.stats(abs))
      if ('problem' in got) return got.problem
      const stats = got.value
      const unit = unitOf(stats)
      if (!stats.textLayer) {
        return `文档：${abs}\n共 ${stats.blockCount} ${unit}，但没有检测到任何文本层——通常是扫描件或纯图片 PDF。当前版本不做 OCR，无法读取内容。`
      }
      const heading = stats.outline.length > 0
        ? `\n\n标题大纲（${stats.outline.length} 条）：\n${stats.outline
          .map(row => `  ${'  '.repeat(Math.max(0, row.level - 1))}L${row.level}　第 ${row.block} ${unit}　${row.text}`)
          .join('\n')}`
        : ''
      const empty = stats.emptyBlocks.length > 0
        ? `\n空白${unit}（无文本，可能是图片页）：${stats.emptyBlocks.slice(0, 40).join(', ')}${stats.emptyBlocks.length > 40 ? ' …' : ''}`
        : ''
      return `文档：${abs}\n共 ${stats.blockCount} ${unit}　总字符数：${stats.totalChars}${empty}${heading}\n\n下一步建议：用 document_search 按关键词定位问题相关段落（它会告诉你第几${unit}、以及所属标题），再用 document_read 精读命中位置。`
    },
  }

  const search = {
    name: 'document_search',
    description: '在整份文档里检索关键词或正则，返回命中所在的块号、匹配内容、前后上下文，以及该处所属的标题层级。这是回答“文档里关于X怎么说”这类问题的定位手段：先检索拿到候选位置，再精读。无需猜测位置，检索会告诉你内容在哪一块。',
    parameters: {
      type: 'object',
      properties: {
        ...pathParams,
        query: { type: 'string', description: '检索词。默认按字面匹配（大小写不敏感）；置 regex 为 true 时按正则解释。' },
        regex: { type: 'boolean', description: '把 query 当作正则表达式（如 “MoE|Mixture-of-Experts”）。' },
        maxHits: { type: 'number', description: `命中条数上限（默认 ${cfg.defaultMaxHits}）。每个块最多返回一条，并标注该块内的出现次数。` },
        context: { type: 'number', description: '每条命中前后各保留的字符数（默认 160）。' },
      },
      required: ['path', 'query'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const abs = toAbsolute(args.path)
      const problem = describePathProblem(abs)
      if (problem !== null) return problem
      if (String(args.query ?? '').trim() === '') return 'query 不能为空。'
      const got = await attempt(() => backend.search(abs, {
        query: String(args.query),
        regex: args.regex === true,
        maxHits: Math.max(1, Math.min(200, Number(args.maxHits) || cfg.defaultMaxHits)),
        context: Math.max(0, Math.min(2000, Number(args.context) || 160)),
      }))
      if ('problem' in got) return got.problem
      const result = got.value
      const unit = unitOf(result)
      if (!result.textLayer) {
        return `文档：${abs}\n没有检测到文本层（通常是扫描件），无法检索。当前版本不做 OCR。`
      }
      if (result.hitCount === 0) {
        return `文档：${abs}\n检索“${result.query}”无命中（共 ${result.blockCount} ${unit}）。\n建议：换用同义词、更短的词，或置 regex 为 true 用正则（例如把多个说法写成 “A|B”）。`
      }
      const lines = result.hits.map((hit) => {
        const times = hit.occurrences > 1 ? `（本块出现 ${hit.occurrences} 次）` : ''
        const where = hit.heading ? `　所属标题：${hit.heading}` : ''
        return `第 ${hit.block} ${unit}${times}${where}\n  …${hit.snippet}…`
      })
      const more = result.truncated ? `\n（命中已达上限 ${result.hitCount} 条，可能还有更多；可提高 maxHits，或直接指定位置精读）` : ''
      return `文档：${abs}\n检索“${result.query}”命中 ${result.hitCount} ${unit}${more}\n\n${lines.join('\n\n')}\n\n下一步建议：用 document_read 精读上述位置，再作答；引用时请标注${unit}号或标题。`
    },
  }

  const read = {
    name: 'document_read',
    description: '精读文档的连续若干块（PDF 为页，Word 为段/标题/表格行），返回带位置标注的正文。先 outline 看结构、search 定位，再用它读原文——不要一次读遍全文。回答需要引用文档时，据此标注位置。',
    parameters: {
      type: 'object',
      properties: {
        ...pathParams,
        start: { type: 'number', description: '起始位置（1 起，默认 1）。' },
        count: { type: 'number', description: `读取块数（默认 ${cfg.defaultWindow}，上限 ${cfg.maxWindow}）。` },
      },
      required: ['path'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const abs = toAbsolute(args.path)
      const problem = describePathProblem(abs)
      if (problem !== null) return problem
      const start = Math.max(1, Number(args.start) || 1)
      const count = Math.max(1, Math.min(cfg.maxWindow, Number(args.count ?? cfg.defaultWindow)))
      const got = await attempt(() => backend.extract(abs, { start, count }))
      if ('problem' in got) return got.problem
      const result = got.value
      const unit = unitOf(result)
      const chunks = []
      let truncatedBlocks = 0
      for (const block of result.blocks) {
        const label = block.kind === 'heading'
          ? `第 ${block.index} ${unit}【标题 L${block.level}】`
          : block.kind === 'table'
            ? `第 ${block.index} ${unit}【表格行】`
            : `第 ${block.index} ${unit}`
        let text = block.text.trim()
        if (text === '') {
          chunks.push(`—— ${label} ——\n（本块无文本；可能是图片页或扫描页，当前版本不做 OCR）`)
          continue
        }
        if (text.length > cfg.maxBlockChars) {
          // Keep the head of an oversized block and point at search, rather
          // than silently burning the context or dropping it entirely.
          truncatedBlocks += 1
          text = `${text.slice(0, cfg.maxBlockChars)}\n…（本块超过 ${cfg.maxBlockChars} 字符已截断）`
        }
        chunks.push(`—— ${label} ——\n${text}`)
      }
      const footer = result.hasMore
        ? `\n\n（全文共 ${result.blockCount} ${unit}，已读 ${result.start}–${result.end}；需要后续内容请提高 start。）`
        : `\n\n（全文共 ${result.blockCount} ${unit}，已读到末尾。）`
      const note = truncatedBlocks > 0
        ? `\n⚠️ 有 ${truncatedBlocks} 块因过长被截断；可用 document_search 在该位置内定位具体段落。`
        : ''
      return `文档：${abs}${footer}${note}\n\n${chunks.join('\n\n')}`
    },
  }

  return { outline, search, read, backend }
}

/**
 * Register the document retrieval tools.
 * @param {object} ctx - owning Cordis context.
 * @param {object} [config] - plugin configuration overriding {@link DEFAULT_CONFIG}.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const { outline, search, read } = buildTools(cfg)
  ctx.logger?.info?.('dsh-doc-attach: document retrieval tools loaded')
  ctx.effect(() => ctx.tools.register(outline), 'dsh-doc-attach: register document_outline')
  ctx.effect(() => ctx.tools.register(search), 'dsh-doc-attach: register document_search')
  ctx.effect(() => ctx.tools.register(read), 'dsh-doc-attach: register document_read')
}

/** Exported for tests: build the tool set without a live Cordis context. */
export { buildTools, toAbsolute, describePathProblem, humanSize }
