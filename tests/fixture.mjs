/**
 * Shared test fixtures for the document backend suites.
 *
 * The Word fixture is GENERATED, never committed: it must contain no real
 * content, and it has to be reproducible and reviewable. Generation spawns
 * Python with `stdio: 'ignore'` — the sandbox denies named pipes, so a piped
 * spawn would fail with EPERM before Python ever ran.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
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

/**
 * Optional local PDF fixtures.
 *
 * These are real documents that live on a developer's machine, so their paths
 * must not be committed — an earlier revision of this very file published a
 * user name and two personal document paths. They are supplied instead by
 * `tests/fixtures.local.json` (git-ignored) or by the environment, and the
 * checks that need them report SKIP when they are absent. An honest gap beats a
 * green run that silently did not run.
 *
 * Shape of the local file:
 *   { "pdf": { "paper": "<absolute path>", "cjk": "<absolute path>" } }
 */
const LOCAL_FIXTURES = join(HERE, 'fixtures.local.json')

/** Tagged error: `check` turns this into a SKIP rather than a failure. */
export const FIXTURE_MISSING = 'FIXTURE_MISSING'

/** The optional local fixture map, or {} when the developer has not made one. */
function readLocalFixtures() {
  try {
    return JSON.parse(readFileSync(LOCAL_FIXTURES, 'utf8'))
  } catch {
    return {}
  }
}

const LOCAL = readLocalFixtures()

/** One optional PDF fixture's path, or a tagged error naming what to configure. */
function optionalPdf(role, envName) {
  const fromEnv = process.env[envName]
  const fromFile = LOCAL?.pdf?.[role]
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  if (typeof fromFile === 'string' && fromFile !== '') return fromFile
  throw Object.assign(
    new Error(`no ${role} PDF fixture — set ${envName} or tests/fixtures.local.json`),
    { code: FIXTURE_MISSING },
  )
}

/**
 * Real PDFs, when this machine has them. Reading a property throws a tagged
 * error if the fixture is absent; `check` reports that as SKIP.
 */
export const PDF_FIXTURES = {
  get paper() { return optionalPdf('paper', 'DSH_DOC_PDF') },
  get cjk() { return optionalPdf('cjk', 'DSH_DOC_PDF_CJK') },
}

/** A suite header summary that never throws on a missing fixture. */
export function describePdfFixtures() {
  const show = (role, envName) => {
    try {
      return optionalPdf(role, envName)
    } catch {
      return '(absent — dependent checks will SKIP)'
    }
  }
  return { paper: show('paper', 'DSH_DOC_PDF'), cjk: show('cjk', 'DSH_DOC_PDF_CJK') }
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
  let skipped = 0
  console.log(title)
  console.log('')
  return {
    async check(name, fn) {
      try {
        await fn()
        passed += 1
        console.log(`  PASS  ${name}`)
      } catch (error) {
        // A missing optional fixture is a gap in coverage, not a defect. Report
        // it as SKIP and keep the count visible, so nobody mistakes a shrunken
        // suite for a passing one.
        if (error?.code === FIXTURE_MISSING) {
          skipped += 1
          console.log(`  SKIP  ${name}`)
          console.log(`        ${error.message}`)
          return
        }
        failed += 1
        console.log(`  FAIL  ${name}`)
        console.log(`        ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    },
    finish() {
      console.log('')
      const suffix = skipped > 0 ? `, ${skipped} skipped` : ''
      console.log(`${passed} passed, ${failed} failed${suffix}`)
      process.exit(failed === 0 ? 0 : 1)
    },
  }
}
