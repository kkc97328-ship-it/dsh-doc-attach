/**
 * Run every dsh-doc-attach test suite and report one verdict.
 *
 * Run: node dsh-doc-attach/tests/run-all.mjs
 *
 * Children are spawned with `stdio: 'inherit'`, never a pipe: under the
 * confined sandbox a child process cannot open named pipes, so capturing
 * output would fail with `spawn EPERM` before the suite even starts. Inherited
 * stdio streams straight through and is permitted.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const SUITES = [
  ['client packaging contract (rows / entries / bundle)', 'test-composition.mjs'],
  ['extension consistency (four allow-lists agree)', 'test-extension-consistency.mjs'],
  ['document backend (extract / search / stats)', 'test-document-backend.mjs'],
  ['legacy .doc (OLE2 container reader)', 'test-doc-format.mjs'],
  ['PowerPoint (.pptx and legacy .ppt)', 'test-ppt-format.mjs'],
  ['host tools (outline / search / read + QA flow)', 'test-document-tools.mjs'],
  ['drop-ingest endpoint (upload + security)', 'test-drop-ingest.mjs'],
  ['client bundle (drop / paste / upload / draft)', 'test-client-bundle.mjs'],
]

/** Run one suite, resolving with its exit code. */
function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], { stdio: 'inherit', windowsHide: true })
    child.on('error', () => resolve(1))
    child.on('close', code => resolve(code ?? 1))
  })
}

const failures = []
for (const [label, file] of SUITES) {
  console.log(`\n${'='.repeat(64)}\n${label}\n${'='.repeat(64)}`)
  const code = await run(file)
  if (code !== 0) failures.push(file)
}

console.log(`\n${'='.repeat(64)}`)
if (failures.length === 0) {
  console.log(`ALL SUITES PASSED (${SUITES.length}/${SUITES.length})`)
} else {
  console.log(`FAILED: ${failures.join(', ')}`)
}
process.exit(failures.length === 0 ? 0 : 1)
