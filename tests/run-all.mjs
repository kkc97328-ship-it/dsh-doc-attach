/**
 * Run every dsh-doc-attach test suite and report one verdict.
 *
 * Run: node tests/run-all.mjs              # everything
 *      node tests/run-all.mjs --portable   # only what runs without this machine
 *
 * Children are spawned with `stdio: 'inherit'`, never a pipe: under the
 * confined sandbox a child process cannot open named pipes, so capturing
 * output would fail with `spawn EPERM` before the suite even starts. Inherited
 * stdio streams straight through and is permitted.
 *
 * The `portable` flag per suite is the explicit answer to "can this run in
 * CI?". Four suites depend on fixtures that only exist on a development
 * machine — two real PDFs under a user profile, and Office-shipped `.doc` /
 * `.ppt` samples — so a CI job that ran them would fail for reasons that say
 * nothing about the code. Marking them here keeps that distinction in the
 * repository instead of in someone's memory.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * `[label, file, portable]`.
 *
 * portable = runs anywhere with Node, using only temporary files and fixtures
 * it generates itself (or skips cleanly when its fixture is absent).
 */
const SUITES = [
  ['client packaging contract (rows / entries / bundle)', 'test-composition.mjs', true],
  ['extension consistency (four allow-lists agree)', 'test-extension-consistency.mjs', true],
  ['drop-ingest endpoint (upload + security)', 'test-drop-ingest.mjs', true],
  ['client bundle (drop / paste / upload / draft)', 'test-client-bundle.mjs', true],
  // Below: need this machine's fixtures (real PDFs, Office .doc/.ppt samples).
  ['document backend (extract / search / stats)', 'test-document-backend.mjs', false],
  ['legacy .doc (OLE2 container reader)', 'test-doc-format.mjs', false],
  ['PowerPoint (.pptx and legacy .ppt)', 'test-ppt-format.mjs', false],
  ['host tools (outline / search / read + QA flow)', 'test-document-tools.mjs', false],
]

const portableOnly = process.argv.includes('--portable')
const selected = portableOnly ? SUITES.filter(([, , portable]) => portable) : SUITES

if (portableOnly) {
  console.log(`Running the portable subset only (${selected.length} of ${SUITES.length} suites).`)
  console.log('The rest need fixtures from a development machine and are skipped by design.')
}

/** Run one suite, resolving with its exit code. */
function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], { stdio: 'inherit', windowsHide: true })
    child.on('error', () => resolve(1))
    child.on('close', code => resolve(code ?? 1))
  })
}

const failures = []
for (const [label, file] of selected) {
  console.log(`\n${'='.repeat(64)}\n${label}\n${'='.repeat(64)}`)
  const code = await run(file)
  if (code !== 0) failures.push(file)
}

console.log(`\n${'='.repeat(64)}`)
if (failures.length === 0) {
  console.log(`ALL SUITES PASSED (${selected.length}/${selected.length})`)
} else {
  console.log(`FAILED: ${failures.join(', ')}`)
}
process.exit(failures.length === 0 ? 0 : 1)
