/**
 * Regenerate every extension allow-list from `formats.json`.
 *
 * WHY A GENERATOR AND NOT AN IMPORT
 * The same fact — "which containers does this plugin accept" — is consumed by
 * five files that cannot import one another:
 *
 *   - `lib/client.js` is a CLASSIC SCRIPT loaded by `__ModuleLoader__.load`;
 *     it has no module graph, so it cannot import a constant.
 *   - `lib/extract/document_helper.py` is Python.
 *   - The host rows are ESM.
 *
 * The package also has NO build step, by design. So the single source is
 * `formats.json` and this script writes the literal into each consumer between
 * named markers. `tests/test-extension-consistency.mjs` runs this with
 * `--check`, so a stale copy fails the suite instead of surviving to a live
 * drop where a readable document is refused at the drop target.
 *
 * Usage:
 *   node scripts/sync-formats.mjs           # rewrite stale blocks in place
 *   node scripts/sync-formats.mjs --check    # exit 1 if anything is stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/** Read and validate the single source of truth. */
export function readFormats(file = join(ROOT, 'formats.json')) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const formats = manifest.formats
  if (!Array.isArray(formats) || formats.length === 0) {
    throw new Error('formats.json: `formats` must be a non-empty array')
  }
  for (const entry of formats) {
    for (const field of ['ext', 'id', 'unit', 'label']) {
      if (typeof entry[field] !== 'string' || entry[field] === '') {
        throw new Error(`formats.json: entry ${JSON.stringify(entry)} has no usable \`${field}\``)
      }
    }
    if (!/^\.[a-z0-9]+$/.test(entry.ext)) {
      throw new Error(`formats.json: ${JSON.stringify(entry.ext)} is not a lowercase extension with a leading dot`)
    }
  }
  const foreign = manifest.foreign ?? []
  if (!Array.isArray(foreign)) throw new Error('formats.json: `foreign` must be an array')
  const readable = formats.map(entry => entry.ext)
  const clash = readable.filter(ext => foreign.includes(ext))
  if (clash.length > 0) {
    throw new Error(`formats.json: ${clash.join(', ')} is listed as both readable and foreign`)
  }
  return { formats, foreign, readable }
}

/** `['a','b']` as a JS array literal. */
const jsArray = extensions => `[${extensions.map(ext => `'${ext}'`).join(', ')}]`

/** `['a','b']` as a `new Set([...])` expression. */
const jsSet = extensions => `new Set(${jsArray(extensions)})`

/**
 * Every generated block, in file order.
 *
 * `indent` is emitted verbatim on the markers and on each rendered line, so a
 * block nested inside the browser bundle's factory keeps its indentation.
 * `comment` matches the host language so the markers stay readable.
 */
export const SITES = [
  {
    file: 'plugins/read-document.mjs',
    name: 'readable',
    comment: '//',
    indent: '',
    render: ({ readable }) => [`const READABLE = ${jsSet(readable)}`],
  },
  {
    file: 'plugins/read-document.mjs',
    name: 'foreign',
    comment: '//',
    indent: '',
    render: ({ foreign }) => [`const FOREIGN = ${jsSet(foreign)}`],
  },
  {
    file: 'plugins/drop-ingest.mjs',
    name: 'extensions',
    comment: '//',
    indent: '  ',
    render: ({ readable }) => [`extensions: ${jsArray(readable)},`],
  },
  {
    file: 'lib/extract/document-python.mjs',
    name: 'extensions',
    comment: '//',
    indent: '',
    render: ({ readable }) => [`export const SUPPORTED_EXTENSIONS = ${jsArray(readable)}`],
  },
  {
    file: 'lib/client.js',
    name: 'readable',
    comment: '//',
    indent: '      ',
    render: ({ readable }) => [`var ACCEPTED = ${jsArray(readable)}`],
  },
  {
    file: 'lib/extract/document_helper.py',
    name: 'maps',
    comment: '#',
    indent: '',
    render: ({ formats }) => [
      'FORMAT_BY_EXT = {',
      ...formats.map(entry => `    ${JSON.stringify(entry.ext)}: ${JSON.stringify(entry.id)},`),
      '}',
      '# A .pptx has real slides; a legacy .ppt does not expose a reliable slide',
      '# number, so its unit is the block its reader actually produces.',
      'UNIT_BY_FORMAT = {',
      ...formats.map(entry => `    ${JSON.stringify(entry.id)}: ${JSON.stringify(entry.unit)},`),
      '}',
    ],
  },
]

/** Marker text for a block, without the comment prefix. */
const markerText = (verb, name) =>
  `${verb} GENERATED:${name} — source: formats.json; run \`node scripts/sync-formats.mjs\``

/**
 * Rewrite one site's block.
 * @returns {{ text: string, changed: boolean, problem: string | null }}
 */
function rewrite(text, site, manifest) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const beginAt = lines.findIndex(line => line.includes(`BEGIN GENERATED:${site.name}`))
  const endAt = lines.findIndex(line => line.includes(`END GENERATED:${site.name}`))
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    return { text, changed: false, problem: `missing markers for "${site.name}"` }
  }
  const block = [
    `${site.indent}${site.comment} ${markerText('BEGIN', site.name)}`,
    ...site.render(manifest).map(line => (line === '' ? '' : `${site.indent}${line}`)),
    `${site.indent}${site.comment} ${markerText('END', site.name)}`,
  ]
  const before = lines.slice(beginAt, endAt + 1)
  const changed = before.join('\n') !== block.join('\n')
  if (!changed) return { text, changed: false, problem: null }
  const next = [...lines.slice(0, beginAt), ...block, ...lines.slice(endAt + 1)].join(eol)
  return { text: next, changed: true, problem: null }
}

/**
 * Walk every site.
 * @param {boolean} write - rewrite stale files when true; only report when false.
 * @returns {{ stale: string[], problems: string[] }}
 */
export function sync(write, manifest = readFormats()) {
  const stale = []
  const problems = []
  for (const site of SITES) {
    const path = join(ROOT, site.file)
    const original = readFileSync(path, 'utf8')
    const { text, changed, problem } = rewrite(original, site, manifest)
    if (problem !== null) {
      problems.push(`${site.file} (#${site.name}): ${problem}`)
      continue
    }
    if (changed) {
      stale.push(`${site.file} (#${site.name})`)
      if (write) writeFileSync(path, text)
    }
  }
  return { stale, problems }
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check')
  const manifest = readFormats()
  const { stale, problems } = sync(!check, manifest)
  const summary = `${manifest.readable.length} formats: ${manifest.readable.join(' ')}`

  for (const problem of problems) console.error(`  ERROR ${problem}`)
  for (const file of stale) console.log(`  ${check ? 'STALE' : 'WROTE'} ${file}`)

  if (problems.length > 0) process.exit(1)
  if (check && stale.length > 0) {
    console.error(`\n${stale.length} generated block(s) are stale. Run: node scripts/sync-formats.mjs`)
    process.exit(1)
  }
  console.log(check ? `  all generated blocks match (${summary})` : `  rewritten (${summary})`)
}
