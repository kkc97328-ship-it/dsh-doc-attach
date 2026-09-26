/**
 * Document text backend: a bridge to a local Python helper.
 *
 * Why a subprocess instead of a library: this deployment has no reachable
 * module registry and no JS document parser, while the machine's Python
 * already ships PyPDF2 (for PDF) and — more importantly — the standard
 * library's `zipfile` (for OOXML Word documents, so no python-docx is needed).
 *
 * Why the result travels through a FILE, not stdout: under the confined
 * sandbox this plugin runs in, a child process cannot open named pipes, so
 * `execFile`/`spawn` with piped stdio fails with `spawn EPERM` (verified by
 * `_probe/spawn-stdio-probe.mjs`). Spawning with `stdio: 'ignore'` and reading
 * an `--out` file is the permitted mode, and it also removes stdout buffer
 * ceilings.
 *
 * One unit concept crosses this boundary: a **block**. For a PDF a block is a
 * page; for Word it is a paragraph, a heading, or one table row. `stats`
 * gives the whole view, `search` locates a passage, `extract` reads a window.
 * This module never summarises or interprets content — that is the caller's
 * job, and doing it on retrieved excerpts is what keeps results accurate and
 * cheap.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Helper script, resolved relative to this module. */
export const DEFAULT_HELPER_PATH = join(HERE, 'document_helper.py')

/** Default block cache; repeated searches on one document reuse one pass. */
export const DEFAULT_CACHE_DIR = join(tmpdir(), 'dsh-doc-attach-cache')

/** Extensions this backend can read. */
export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.pptx', '.ppt']

/**
 * @typedef {'BACKEND_UNAVAILABLE' | 'NOT_FOUND' | 'UNREADABLE' | 'NO_TEXT_LAYER'
 *   | 'EMPTY_DOCUMENT' | 'UNSUPPORTED_FORMAT' | 'BAD_RANGE' | 'BAD_QUERY'
 *   | 'EXTRACTION_FAILED'} DocumentErrorCode
 *
 * Failure classes callers may branch on:
 * - `BACKEND_UNAVAILABLE` no usable interpreter, or a missing PDF dependency
 * - `NOT_FOUND` the file is absent
 * - `UNREADABLE` the file exists but is not a parseable document
 * - `NO_TEXT_LAYER` no extractable text anywhere (almost always a scan)
 * - `EMPTY_DOCUMENT` parsed, but its body holds no readable content
 * - `UNSUPPORTED_FORMAT` this backend has no reader for that container
 * - `BAD_RANGE` the request asked for something the backend rejects
 * - `BAD_QUERY` the search query is empty or an invalid pattern
 * - `EXTRACTION_FAILED` the subprocess failed or exceeded its budget
 */

/** Typed extraction failure carrying a machine-readable code. */
export class DocumentExtractionError extends Error {
  /**
   * @param {DocumentErrorCode} code - failure class for caller branching.
   * @param {string} message - human-readable detail.
   */
  constructor(code, message) {
    super(message)
    this.name = 'DocumentExtractionError'
    /** @type {DocumentErrorCode} */
    this.code = code
  }
}

/**
 * @typedef {object} Block
 * @property {number} index 1-based block number within the document.
 * @property {'page'|'paragraph'|'heading'|'table'} kind What this block is.
 * @property {string} text Readable text, possibly empty.
 * @property {number} [level] Heading level, present only for headings.
 * @property {number} [row] Table row number, present only for table rows.
 * @property {string} [warning] Per-block failure when only this block failed.
 */

/**
 * @typedef {object} BlockHeading
 * @property {number} block 1-based block number of the heading.
 * @property {number} level Heading level.
 * @property {string} text Heading text.
 */

/**
 * @typedef {object} DocumentStats
 * @property {'pdf'|'docx'} format Source container.
 * @property {'page'|'block'|'slide'} unit What one block means here.
 * @property {number} blockCount Total blocks.
 * @property {number} totalChars Characters across all blocks.
 * @property {boolean} textLayer Whether any text was found.
 * @property {number[]} emptyBlocks Blocks yielding no text.
 * @property {BlockHeading[]} outline Heading outline (empty for PDFs).
 */

/**
 * @typedef {object} SearchHit
 * @property {number} block 1-based block the hit is in.
 * @property {string} kind Block kind at the hit.
 * @property {string} match The matched substring.
 * @property {number} occurrences How many times the query matched in that block.
 * @property {string} snippet Whitespace-collapsed context around the hit.
 * @property {string} heading Nearest preceding heading, for orientation.
 */

/**
 * @typedef {object} DocumentSearch
 * @property {'pdf'|'docx'} format Source container.
 * @property {'page'|'block'|'slide'} unit What one block means here.
 * @property {number} blockCount Total blocks.
 * @property {string} query The query as submitted.
 * @property {boolean} regex Whether the query was treated as a pattern.
 * @property {number} hitCount Hits returned.
 * @property {boolean} truncated Whether more hits existed beyond the ceiling.
 * @property {boolean} textLayer Whether the document has any text layer.
 * @property {SearchHit[]} hits Hits in document order.
 */

/**
 * @typedef {object} DocumentWindow
 * @property {'pdf'|'docx'} format Source container.
 * @property {'page'|'block'|'slide'} unit What one block means here.
 * @property {number} blockCount Total blocks.
 * @property {number} start 1-based first block of this window.
 * @property {number} end 1-based last block of this window.
 * @property {boolean} hasMore Whether blocks exist beyond this window.
 * @property {Block[]} blocks Blocks in this window, in document order.
 */

/**
 * @typedef {object} HelperEnvelope
 * @property {boolean} ok
 * @property {string} [format]
 * @property {string} [unit]
 * @property {number} [blockCount]
 * @property {number} [start]
 * @property {number} [end]
 * @property {boolean} [hasMore]
 * @property {boolean} [textLayer]
 * @property {Block[]} [blocks]
 * @property {BlockHeading[]} [outline]
 * @property {number} [totalChars]
 * @property {number[]} [emptyBlocks]
 * @property {string} [query]
 * @property {boolean} [regex]
 * @property {number} [hitCount]
 * @property {boolean} [truncated]
 * @property {SearchHit[]} [hits]
 * @property {{ code: string, message: string }} [error]
 */

/**
 * Document backend backed by `python <helper>`.
 *
 * Discovery is lazy and memoized: the first `probe()` walks the candidate
 * interpreter list once and records either a working one or the failure, so a
 * broken environment costs one round trip rather than one per document.
 *
 * The probe deliberately does NOT require PyPDF2: Word extraction needs only
 * the standard library, so demanding a PDF dependency to read a .docx would
 * refuse work this backend can actually do. A missing PDF dependency surfaces
 * on the first PDF call instead, naming PyPDF2 in the message.
 */
export class PythonDocumentBackend {
  /**
   * @param {object} [options]
   * @param {string} [options.pythonPath] Explicit interpreter; discovery runs
   *   when absent. `DSH_DOC_PYTHON` is read when this is unset.
   * @param {string} [options.helperPath] Helper script path.
   * @param {number} [options.timeoutMs] Per-invocation budget.
   * @param {string[]} [options.candidates] Discovery order.
   * @param {string} [options.cacheDir] Block cache; pass `''` to disable.
   */
  constructor(options = {}) {
    this.helperPath = options.helperPath ?? DEFAULT_HELPER_PATH
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR
    const configured = options.pythonPath ?? process.env.DSH_DOC_PYTHON
    this.candidates = configured !== undefined && configured !== ''
      ? [configured]
      : options.candidates ?? ['python', 'python3', 'py']
    /** @type {string | undefined} */
    this.resolved = undefined
    /** @type {DocumentExtractionError | undefined} */
    this.failure = undefined
    /** @type {Promise<void> | undefined} */
    this.probing = undefined
  }

  /**
   * Resolve the backend once, rejecting `BACKEND_UNAVAILABLE` when unusable.
   * @returns {Promise<void>} resolution, or the recorded capability failure.
   */
  async probe() {
    if (this.resolved !== undefined) return
    if (this.failure !== undefined) throw this.failure
    this.probing ??= this.#runProbe()
    return this.probing
  }

  /** Walk the candidate list once and record the first usable interpreter. */
  async #runProbe() {
    /** @type {string[]} */
    const attempts = []
    for (const candidate of this.candidates) {
      // Any structured envelope proves the interpreter ran the helper. The
      // probe target has no known extension, so the expected answer is
      // UNSUPPORTED_FORMAT — a normal reply, not a capability failure.
      const probeTarget = join(HERE, '__dsh_doc_probe__')
      try {
        const envelope = await this.#invoke(candidate, ['--file', probeTarget, '--mode', 'stats'])
        if (typeof envelope.ok === 'boolean') {
          this.resolved = candidate
          return
        }
        attempts.push(`${candidate}: reply was not an envelope`)
      } catch (error) {
        attempts.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.failure = new DocumentExtractionError(
      'BACKEND_UNAVAILABLE',
      'no usable Python backend. Set DSH_DOC_PYTHON (or the row\'s pythonPath) to an interpreter '
      + `that can run document_helper.py. Tried: ${attempts.join('; ')}`,
    )
    throw this.failure
  }

  /**
   * Cheap whole-document view: block count, per-block size, heading outline.
   * This is what lets a caller decide where to look before reading anything.
   * @param {string} filePath - absolute path to the document.
   * @returns {Promise<DocumentStats>} structural summary.
   */
  async stats(filePath) {
    const envelope = await this.#call(['--file', filePath, '--mode', 'stats'])
    return {
      format: /** @type {'pdf'|'docx'} */ (envelope.format ?? 'pdf'),
      unit: /** @type {'page'|'block'|'slide'} */ (envelope.unit ?? 'page'),
      blockCount: envelope.blockCount ?? 0,
      totalChars: envelope.totalChars ?? 0,
      textLayer: envelope.textLayer ?? false,
      emptyBlocks: envelope.emptyBlocks ?? [],
      outline: envelope.outline ?? [],
    }
  }

  /**
   * Locate a query across the whole document, returning block-anchored hits.
   * @param {string} filePath - absolute path to the document.
   * @param {{ query: string, regex?: boolean, maxHits?: number, context?: number }} request -
   *   query text or pattern, hit ceiling, and snippet size.
   * @returns {Promise<DocumentSearch>} hits in document order.
   */
  async search(filePath, request) {
    const envelope = await this.#call([
      '--file', filePath, '--mode', 'search',
      '--query', request.query,
      ...(request.regex === true ? ['--regex'] : []),
      '--max-hits', String(request.maxHits ?? 30),
      '--context', String(request.context ?? 160),
    ])
    return {
      format: /** @type {'pdf'|'docx'} */ (envelope.format ?? 'pdf'),
      unit: /** @type {'page'|'block'|'slide'} */ (envelope.unit ?? 'page'),
      blockCount: envelope.blockCount ?? 0,
      query: envelope.query ?? request.query,
      regex: envelope.regex ?? false,
      hitCount: envelope.hitCount ?? 0,
      truncated: envelope.truncated ?? false,
      textLayer: envelope.textLayer ?? false,
      hits: envelope.hits ?? [],
    }
  }

  /**
   * Read one window of blocks, for precise reading.
   * @param {string} filePath - absolute path to the document.
   * @param {{ start: number, count: number }} window - 1-based window.
   * @returns {Promise<DocumentWindow>} window plus document metadata.
   */
  async extract(filePath, window) {
    const envelope = await this.#call([
      '--file', filePath, '--mode', 'extract',
      '--start', String(window.start), '--count', String(window.count),
    ])
    const blocks = envelope.blocks ?? []
    const hasText = blocks.some(block => block.text.trim() !== '')
    // Zero text across a whole document is a scan, not a successful empty
    // read; the caller must be able to say so instead of showing blanks.
    if (!hasText && envelope.textLayer !== true && window.start === 1) {
      throw new DocumentExtractionError(
        'NO_TEXT_LAYER',
        `no text layer in blocks ${envelope.start}-${envelope.end}`,
      )
    }
    return {
      format: /** @type {'pdf'|'docx'} */ (envelope.format ?? 'pdf'),
      unit: /** @type {'page'|'block'|'slide'} */ (envelope.unit ?? 'page'),
      blockCount: envelope.blockCount ?? 0,
      start: envelope.start ?? window.start,
      end: envelope.end ?? window.start,
      hasMore: envelope.hasMore ?? false,
      blocks,
    }
  }

  /**
   * Probe once, then run one helper invocation and decode its envelope.
   * @param {string[]} args - helper arguments after the interpreter.
   * @returns {Promise<HelperEnvelope>} the decoded envelope.
   */
  async #call(args) {
    await this.probe()
    const envelope = await this.#invoke(/** @type {string} */ (this.resolved), args)
    if (envelope.error !== undefined) {
      throw new DocumentExtractionError(
        /** @type {DocumentErrorCode} */ (envelope.error.code), envelope.error.message,
      )
    }
    if (envelope.ok !== true) {
      throw new DocumentExtractionError(
        'EXTRACTION_FAILED', `helper returned an unrecognised envelope: ${JSON.stringify(envelope).slice(0, 200)}`,
      )
    }
    return envelope
  }

  /**
   * Run the helper once, handing the result back through a temp file.
   * @param {string} python - interpreter to invoke.
   * @param {string[]} helperArgs - arguments after the helper path.
   * @returns {Promise<HelperEnvelope>} the decoded envelope.
   */
  #invoke(python, helperArgs) {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-doc-'))
    const outPath = join(scratch, 'result.json')
    const logPath = join(scratch, 'crash.log')
    const args = [
      ...(python === 'py' ? ['-3'] : []),
      this.helperPath,
      ...helperArgs,
      '--out', outPath,
      '--log', logPath,
      ...(this.cacheDir === '' ? [] : ['--cache-dir', this.cacheDir]),
    ]
    return new Promise((resolve, reject) => {
      /** @type {import('node:child_process').ChildProcess} */
      let child
      try {
        // 'ignore' is the only stdio mode the confined sandbox permits; a pipe
        // here fails with EPERM before the process starts.
        child = spawn(python, args, { stdio: 'ignore', windowsHide: true })
      } catch (error) {
        rmSync(scratch, { recursive: true, force: true })
        reject(new DocumentExtractionError(
          'BACKEND_UNAVAILABLE',
          `${python} could not be started: ${error instanceof Error ? error.message : String(error)}`,
        ))
        return
      }

      /** @type {NodeJS.Timeout | undefined} */
      let timer
      const settle = (fn) => {
        if (timer !== undefined) clearTimeout(timer)
        rmSync(scratch, { recursive: true, force: true })
        fn()
      }
      timer = setTimeout(() => {
        child.kill()
        settle(() => reject(new DocumentExtractionError(
          'EXTRACTION_FAILED', `${python} exceeded ${this.timeoutMs}ms`,
        )))
      }, this.timeoutMs)

      child.on('error', (error) => {
        settle(() => reject(new DocumentExtractionError(
          'BACKEND_UNAVAILABLE', `${python} could not be started: ${error.message}`,
        )))
      })
      child.on('close', (code) => {
        let raw
        try {
          raw = readFileSync(outPath, 'utf8')
        } catch {
          // No result file means the helper died before writing one; the crash
          // log is the only diagnostic available with stderr discarded.
          let detail = ''
          try { detail = readFileSync(logPath, 'utf8').trim().split('\n').slice(-3).join(' | ') } catch { /* no log either */ }
          settle(() => reject(new DocumentExtractionError(
            'EXTRACTION_FAILED',
            `${python} exited ${code} without a result file${detail === '' ? '' : `: ${detail}`}`,
          )))
          return
        }
        let envelope
        try {
          envelope = JSON.parse(raw)
        } catch {
          settle(() => reject(new DocumentExtractionError(
            'EXTRACTION_FAILED', `helper wrote non-JSON output: ${raw.slice(0, 200)}`,
          )))
          return
        }
        settle(() => resolve(envelope))
      })
    })
  }
}
