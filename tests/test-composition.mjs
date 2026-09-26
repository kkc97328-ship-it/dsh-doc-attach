/**
 * Verification for the client-packaging contract.
 *
 * Run: node dsh-doc-attach/tests/test-composition.mjs
 *
 * This suite exists because of a real defect: the package was installed and its
 * host half worked, but the browser half never appeared, and the reason was
 * purely compositional — every row named a subpath, and the client-module
 * registry attributes an entry to a package by resolving
 * `<entry name>/package.json`. A subpath resolves nothing, so the package was
 * cached as "not a client package", permanently.
 *
 * The checks below encode that rule rather than describing it: they resolve the
 * patch's row names exactly the way the registry does, so the same mistake
 * cannot be reinstalled silently.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Where the profile installs it; live checks are skipped when absent. */
const INSTALLED = 'C:\\Users\\LiJia-Chen\\.dsh\\profiles\\web\\node_modules\\dsh-doc-attach'

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

/** Row names declared by the bundle patch, in file order. */
function patchRowNames(text) {
  return [...text.matchAll(/^\s*name:\s*'([^']+)'/gm)].map(match => match[1])
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const patchText = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
const rowNames = patchRowNames(patchText)

console.log('Client packaging contract verification')
console.log(`package: ${manifest.name}`)
console.log(`rows   : ${rowNames.join(', ')}`)
console.log('')

// ── the rule the registry actually applies ────────────────────────────────
await check('at least one row name is a resolvable package root (the bare name)', async () => {
  // Mirrors ClientModuleRegistry.resolvePkgJson: require.resolve(`${spec}/package.json`)
  // anchored at the config tree. From the development copy the package is not
  // installed anywhere, so resolution is simulated against a synthetic anchor:
  // a name is a "package root" only when it has no path separators beyond the
  // package scope. The live check below does the real resolution.
  const bare = rowNames.filter(name => name === manifest.name)
  assert.equal(bare.length, 1, `exactly one row must be named "${manifest.name}"; rows were ${rowNames.join(', ')}`)
})

await check('the root row is not a subpath of the package', async () => {
  for (const name of rowNames) {
    if (!name.startsWith(`${manifest.name}/`)) continue
    assert.ok(
      rowNames.includes(manifest.name),
      `row "${name}" is a subpath, so the package needs a "${manifest.name}" row too`,
    )
  }
})

await check('exports["."] resolves to a real host entry', async () => {
  const root = manifest.exports['.']
  assert.equal(typeof root, 'string', 'exports["."] must be a string path')
  assert.ok(existsSync(join(PACKAGE_ROOT, root)), `exports["."] points at a missing file: ${root}`)
})

await check('the root host entry is an inert plugin, not a functional one', async () => {
  // Loading the root row must not duplicate the tools row's registrations, so
  // its apply() has to do nothing.
  const host = await import(new URL('../lib/host.js', import.meta.url).href)
  assert.equal(typeof host.apply, 'function', 'the root entry must export apply')
  assert.equal(host.inject, undefined, 'the root entry must declare no service dependencies')
  assert.equal(host.apply(), undefined, 'apply() must perform no work')
})

// ── the browser half's own contract ───────────────────────────────────────
await check('dsh.client declares the web platform', async () => {
  assert.equal(manifest.dsh.client.platform, 'web')
})

await check('exports["./client"] resolves to a real bundle', async () => {
  const client = manifest.exports['./client']
  const rel = typeof client === 'string' ? client : client?.default
  assert.equal(typeof rel, 'string', 'exports["./client"] must be a string or {default}')
  assert.ok(existsSync(join(PACKAGE_ROOT, rel)), `missing bundle: ${rel}`)
})

await check('the bundle registers a factory under the package id', async () => {
  const text = readFileSync(join(PACKAGE_ROOT, manifest.exports['./client']), 'utf8')
  assert.ok(text.includes('__ModuleLoader__.load'), 'the bundle must register through the module loader')
  assert.ok(text.includes(`id: '${manifest.name}'`), 'the factory id must equal the package name')
  assert.ok(!/^\s*import\s/m.test(text), 'a bundle is a classic script and must not use static import')
})

// ── the functional rows still resolve ─────────────────────────────────────
await check('every functional row points at an existing module', async () => {
  for (const name of rowNames) {
    if (name === manifest.name) continue
    const rel = name.slice(manifest.name.length + 1)
    assert.ok(existsSync(join(PACKAGE_ROOT, rel)), `row "${name}" points at a missing file`)
  }
})

// ── live resolution against the installed profile copy ────────────────────
if (existsSync(INSTALLED)) {
  const profileRequire = createRequire(join(dirname(INSTALLED), 'noop.js'))
  await check('LIVE: the registry can resolve the package root from the profile', async () => {
    const resolved = profileRequire.resolve(`${manifest.name}/package.json`)
    assert.ok(resolved.includes(manifest.name), resolved)
  })
  await check('LIVE: the installed patch carries the bare-name row', async () => {
    const installed = readFileSync(join(INSTALLED, 'cordis.patch.yml'), 'utf8')
    assert.ok(
      patchRowNames(installed).includes(manifest.name),
      `installed patch rows: ${patchRowNames(installed).join(', ')}`,
    )
  })
  await check('LIVE: the installed root entry matches the development copy', async () => {
    const a = readFileSync(join(PACKAGE_ROOT, manifest.exports['.']), 'utf8')
    const b = readFileSync(join(INSTALLED, manifest.exports['.']), 'utf8')
    assert.equal(a, b, 'the install is stale — re-run install.ps1')
  })
} else {
  console.log('  SKIP  live checks (package not installed at the profile path)')
}

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
