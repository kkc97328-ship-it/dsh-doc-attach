/**
 * Verification that the extension allow-lists agree with each other.
 *
 * Run: node dsh-doc-attach/tests/test-extension-consistency.mjs
 *
 * The same fact — "which containers does this plugin accept" — is declared in
 * four places that cannot import one another: the tool layer's READABLE set,
 * the upload endpoint's `extensions`, the browser bundle's ACCEPTED list (a
 * classic script with no module graph), and the Python backend's
 * SUPPORTED_EXTENSIONS.
 *
 * They already drifted once: `.doc` was added to the host but not to the
 * browser list, so a document the tools could read was still refused at the
 * drop target. This suite reads all four from disk and fails on any
 * disagreement, which is cheaper than discovering it in a live drop.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { suite } from './fixture.mjs'

const ROOT = new URL('..', import.meta.url)
const read = relative => readFileSync(fileURLToPath(new URL(relative, ROOT)), 'utf8')

const { check, finish } = suite('Extension consistency verification')
console.log('')

/** Pull the quoted extensions out of a snippet, in order of appearance. */
const extensionsIn = snippet => [...snippet.matchAll(/'(\.[a-z0-9]+)'/g)].map(match => match[1])

/** The array literal following one anchor. */
function listAfter(source, anchor) {
  const start = source.indexOf(anchor)
  assert.ok(start >= 0, `anchor not found: ${anchor}`)
  const open = source.indexOf('[', start)
  const close = source.indexOf(']', open)
  assert.ok(open >= 0 && close > open, `no array literal after: ${anchor}`)
  return extensionsIn(source.slice(open, close))
}

const toolSource = read('plugins/read-document.mjs')
const dropSource = read('plugins/drop-ingest.mjs')
const clientSource = read('lib/client.js')
const backendSource = read('lib/extract/document-python.mjs')

const toolList = listAfter(toolSource, 'const READABLE = new Set(')
const dropList = listAfter(dropSource, 'extensions:')
const clientList = listAfter(clientSource, 'var ACCEPTED =')
const backendList = listAfter(backendSource, 'export const SUPPORTED_EXTENSIONS =')

console.log(`  tool layer : ${toolList.join(' ')}`)
console.log(`  upload     : ${dropList.join(' ')}`)
console.log(`  browser    : ${clientList.join(' ')}`)
console.log(`  backend    : ${backendList.join(' ')}`)
console.log('')

await check('the tool layer accepts every format the backend can read', async () => {
  assert.deepEqual(
    [...toolList].sort(), [...backendList].sort(),
    'READABLE and SUPPORTED_EXTENSIONS must name the same containers',
  )
})

await check('the upload endpoint accepts exactly what the tool layer can read', async () => {
  // Otherwise a file uploads successfully and is then refused by the tool,
  // which reads as a broken drop rather than an unsupported format.
  assert.deepEqual(
    [...dropList].sort(), [...toolList].sort(),
    'the drop target and the tool layer must agree',
  )
})

await check('the browser offers exactly what the host accepts', async () => {
  assert.deepEqual(
    [...clientList].sort(), [...dropList].sort(),
    'the browser ACCEPTED list and the upload extensions must agree',
  )
})

await check('images are deliberately absent from every list', async () => {
  // Images belong to the harness's own image channel (preview + image blocks).
  // Listing them here would make this plugin intercept them and store them as
  // a document instead of sending them as pictures.
  for (const [name, list] of [['tool', toolList], ['upload', dropList], ['browser', clientList], ['backend', backendList]]) {
    for (const image of ['.png', '.jpg', '.jpeg']) {
      assert.ok(!list.includes(image), `${name} must not list ${image}`)
    }
  }
})

await check('every readable extension has a reader in the helper', async () => {
  const helper = read('lib/extract/document_helper.py')
  for (const extension of toolList) {
    assert.ok(
      helper.includes(`"${extension}"`) || helper.includes(`'${extension}'`),
      `document_helper.py does not mention ${extension}`,
    )
  }
})

finish()
