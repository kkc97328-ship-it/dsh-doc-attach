/**
 * Verification that every extension allow-list matches `formats.json`.
 *
 * Run: node tests/test-extension-consistency.mjs
 *
 * The same fact — "which containers does this plugin accept" — is consumed by
 * five files that cannot import one another: the tool layer's READABLE set, the
 * upload endpoint's `extensions`, the browser bundle's ACCEPTED list (a classic
 * script with no module graph), the Python backend's SUPPORTED_EXTENSIONS, and
 * the helper's FORMAT_BY_EXT / UNIT_BY_FORMAT maps.
 *
 * They already drifted once: `.doc` was added to the host but not to the
 * browser list, so a document the tools could read was still refused at the
 * drop target. The first version of this suite compared the copies pairwise.
 * Now the copies are GENERATED (`scripts/sync-formats.mjs`) and this suite runs
 * the generator's check mode, so the failure mode is "a copy is stale" rather
 * than "some pair disagreed" — and it covers all six blocks, including the
 * Python maps the pairwise version never looked at.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { suite } from './fixture.mjs'
import { SITES, readFormats, sync } from '../scripts/sync-formats.mjs'

const ROOT = new URL('..', import.meta.url)
const read = relative => readFileSync(fileURLToPath(new URL(relative, ROOT)), 'utf8')

const { check, finish } = suite('Extension consistency verification')
console.log('')

const manifest = readFormats()
console.log(`  source of truth : formats.json — ${manifest.readable.join(' ')}`)
console.log(`  refused         : ${manifest.foreign.join(' ')}`)
console.log('')

/** The text between one site's markers. */
function blockOf(site) {
  const source = read(site.file)
  const begin = source.indexOf(`BEGIN GENERATED:${site.name}`)
  const end = source.indexOf(`END GENERATED:${site.name}`)
  assert.ok(begin >= 0 && end > begin, `${site.file} (#${site.name}) is missing its generated markers`)
  return source.slice(begin, end)
}

await check('every generated block matches formats.json', async () => {
  const { stale, problems } = sync(false, manifest)
  assert.deepEqual(problems, [], `markers missing:\n${problems.join('\n')}`)
  assert.deepEqual(stale, [], `stale blocks — run \`node scripts/sync-formats.mjs\`:\n${stale.join('\n')}`)
})

await check('the generator covers every consumer of the list', async () => {
  const files = new Set(SITES.map(site => site.file))
  for (const file of [
    'plugins/read-document.mjs',
    'plugins/drop-ingest.mjs',
    'lib/client.js',
    'lib/extract/document-python.mjs',
    'lib/extract/document_helper.py',
  ]) {
    assert.ok(files.has(file), `${file} must be a generator site, or it can drift again`)
    assert.ok(read(file).includes('BEGIN GENERATED:'), `${file} has no generated block`)
  }
  assert.ok(SITES.length >= 6, 'expected the readable, foreign, extensions and maps blocks')
})

await check('images are deliberately absent from every block', async () => {
  // Images belong to the harness's own image channel (preview + image blocks).
  // Listing them here would make this plugin store a picture as a document
  // instead of sending it as a picture.
  for (const site of SITES) {
    const block = blockOf(site)
    for (const image of ['.png', '.jpg', '.jpeg']) {
      assert.ok(
        !block.includes(`'${image}'`) && !block.includes(`"${image}"`),
        `${site.file} (#${site.name}) must not list ${image}`,
      )
    }
  }
})

await check('readable and refused never overlap', async () => {
  const overlap = manifest.readable.filter(ext => manifest.foreign.includes(ext))
  assert.deepEqual(overlap, [], `these are both readable and refused: ${overlap.join(' ')}`)
})

await check('every readable extension has a reader in the helper', async () => {
  const helper = read('lib/extract/document_helper.py')
  for (const extension of manifest.readable) {
    assert.ok(helper.includes(`"${extension}"`), `document_helper.py does not mention ${extension}`)
  }
})

await check('every format declares a distinct id and a known unit', async () => {
  const ids = manifest.formats.map(entry => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'format ids must be unique')
  const known = new Set(['page', 'block', 'slide', 'row'])
  for (const entry of manifest.formats) {
    assert.ok(known.has(entry.unit), `${entry.ext} declares unknown unit "${entry.unit}"`)
  }
})

finish()
