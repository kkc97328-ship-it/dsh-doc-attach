/**
 * Shared test fixtures for the document backend suites.
 *
 * The Word fixture is GENERATED, never committed: it must contain no real
 * content, and it has to be reproducible and reviewable. Generation spawns
 * Python with `stdio: 'ignore'` — the sandbox denies named pipes, so a piped
 * spawn would fail with EPERM before Python ever ran.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Interpreter used by the suites.
 *
 * Defaults to `python` on PATH rather than an absolute path: a hard-coded
 * interpreter ties the suite to one machine and publishes that machine's
 * directory layout. `DSH_DOC_PYTHON` still overrides it.
 */
export const PYTHON = process.env.DSH_DOC_PYTHON ?? 'python'

/** Real PDFs already present on this machine, used as read-only fixtures. */
export const PDF_FIXTURES = {
  cjk: 'C:\\Users\\LiJia-Chen\\Downloads\\学员须知.pdf',
  paper: 'C:\\Users\\LiJia-Chen\\Downloads\\2412.19437v2.pdf',
}

/**
 * Run one fixture generator and return the file it produced.
 *
 * The generators live beside this module; this wrapper only guarantees the file
 * exists and is non-empty, so a silent generator failure surfaces as a clear
 * test error rather than as a puzzling empty extraction.
 *
 * Generation spawns Python with `stdio: 'ignore'` — the sandbox denies named
 * pipes, so a piped spawn would fail with EPERM before Python ever ran.
 *
 * @param {string} script - generator file name in this directory.
 * @param {string} fileName - name to give the produced fixture.
 * @param {string} [directory] Where to write it; a temp dir by default.
 * @returns {string} absolute path to the fixture.
 */
function ensureGenerated(script, fileName, directory) {
  const target = join(directory ?? mkdtempSync(join(tmpdir(), 'dsh-doc-fixture-')), fileName)
  if (existsSync(target) && statSync(target).size > 0) return target
  const result = spawnSync(PYTHON, [join(HERE, script), target], {
    stdio: 'ignore',
    windowsHide: true,
  })
  if (result.error !== undefined) {
    throw new Error(`could not run ${script}: ${result.error.message}`)
  }
  if (!existsSync(target) || statSync(target).size === 0) {
    throw new Error(`${script} produced no file (exit ${result.status})`)
  }
  return target
}

/**
 * Build the synthetic Word fixture once and return its path.
 * @param {string} [directory] Where to write it; a temp dir by default.
 * @returns {string} absolute path to the .docx.
 */
export function ensureDocxFixture(directory) {
  return ensureGenerated('make-docx-fixture.py', 'fixture.docx', directory)
}

/**
 * Build the synthetic spreadsheet fixture once and return its path.
 * @param {string} [directory] Where to write it; a temp dir by default.
 * @returns {string} absolute path to the .xlsx.
 */
export function ensureXlsxFixture(directory) {
  return ensureGenerated('make-xlsx-fixture.py', 'fixture.xlsx', directory)
}

/**
 * A scratch directory the caller removes when finished.
 * @param {string} label - prefix, so a leftover dir says which suite made it.
 * @returns {string} absolute path.
 */
export function scratchDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-doc-${label}-`))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Remove a scratch directory, ignoring an already-absent one. */
export function cleanUp(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/**
 * A tiny named-check runner, so every suite reports the same way and a single
 * failure never hides the rest of the results.
 * @param {string} title - banner text.
 * @returns {{ check: (name: string, fn: () => any) => Promise<void>, finish: () => never }} runner.
 */
export function suite(title) {
  let passed = 0
  let failed = 0
  console.log(title)
  console.log('')
  return {
    async check(name, fn) {
      try {
        await fn()
        passed += 1
        console.log(`  PASS  ${name}`)
      } catch (error) {
        failed += 1
        console.log(`  FAIL  ${name}`)
        console.log(`        ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    },
    finish() {
      console.log('')
      console.log(`${passed} passed, ${failed} failed`)
      process.exit(failed === 0 ? 0 : 1)
    },
  }
}
