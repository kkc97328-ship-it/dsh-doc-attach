/**
 * Verification for the drop-ingest upload endpoint.
 *
 * Run: node dsh-doc-attach/tests/test-drop-ingest.mjs
 *
 * The endpoint is the one place where browser input reaches the filesystem,
 * so the security checks are the point of this suite: a caller must not be
 * able to name a target the host has not itself approved, escape the drop
 * directory, or overrun the body cap. Each check drives the real handler with
 * a synthetic request and asserts on the response and on what landed on disk.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { apply, buildHandler } from '../plugins/drop-ingest.mjs'

// The sandbox lives beside the package rather than under os.tmpdir(): on
// Windows tmpdir() can hand back an 8.3 short spelling (LIJIA-~1) which
// fs.realpathSync does not expand, while the plugin's async realpath does.
// That discrepancy is an artifact of the test harness, not of the endpoint,
// and a normal workspace path keeps these assertions about containment.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SANDBOX = mkdtempSync(join(PACKAGE_ROOT, '_tmp-drop-'))
const WORKSPACE = join(SANDBOX, 'workspace')
const OUTSIDER = join(SANDBOX, 'outsider')
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(OUTSIDER, { recursive: true })

const WORKSPACE_REAL = realpathSync(WORKSPACE)
const DROPS = join(WORKSPACE_REAL, '.dsh-drops')

/** Canonical, separator-normalized, case-folded form for comparison. */
function canonical(path) {
  let resolved
  try { resolved = realpathSync(path) } catch { resolved = resolve(path) }
  return resolved.replace(/\\/g, '/').toLowerCase()
}

/** Whether a written path sits inside the drop directory. */
function withinDrops(path) {
  return canonical(path).startsWith(canonical(DROPS))
}

const workspaceRegistry = {
  list: () => [{ id: 'ws-1', path: WORKSPACE, title: 'test workspace', sessionIds: ['session-abc'] }],
}

/** Minimal PDF-like payload; the endpoint never parses it, only stores it. */
const PDF_BYTES = Buffer.from('%PDF-1.4\n% test payload\n%%EOF\n', 'utf8')

/** Build a synthetic IncomingMessage-like request carrying a body. */
function makeRequest(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  stream.method = method
  stream.url = url
  return stream
}

/** Build a synthetic ServerResponse-like capture. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
  }
}

/** Drive the handler once and return the parsed response. */
async function call(handler, method, url, payload, encoding = 'json') {
  const body = payload === undefined
    ? undefined
    : (encoding === 'json' ? JSON.stringify(payload) : payload)
  const res = makeResponse()
  await handler(makeRequest(method, url, body), res)
  let parsed
  try { parsed = JSON.parse(res.body) } catch { parsed = undefined }
  return { status: res.statusCode, body: parsed, raw: res.body }
}

const handler = buildHandler(
  { routePath: '/api/doc-attach', dropDirName: '.dsh-drops', extensions: ['.pdf', '.docx'], maxBytes: 1024 * 1024, maxBodyBytes: 4 * 1024 * 1024 },
  { webServer: {}, workspaceRegistry, logger: { warn() {} } },
)

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

console.log('Drop-ingest endpoint verification')
console.log(`workspace : ${WORKSPACE}`)
console.log(`realpath  : ${WORKSPACE_REAL}`)
console.log(`drops     : ${DROPS}`)
console.log('')

// ── wiring ────────────────────────────────────────────────────────────────
await check('apply() claims one prefix route and returns a disposer', async () => {
  const seen = []
  /** @type {(() => void)[]} */
  const disposers = []
  const ctx = {
    logger: { info() {} },
    webServer: { register(route) { seen.push(route); return () => { disposers.push(() => {}) } } },
    workspaceRegistry,
    effect(factory) { disposers.push(factory()); return () => {} },
  }
  apply(ctx, {})
  assert.equal(seen.length, 1)
  assert.equal(seen[0].kind, 'prefix')
  assert.equal(seen[0].path, '/api/doc-attach')
  assert.equal(typeof seen[0].handler, 'function')
  // The factory must hand its disposer back to ctx.effect, which is how the
  // route leaves the composition when the plugin unloads.
  assert.equal(disposers.length, 1, 'ctx.effect received one factory')
  assert.equal(typeof disposers[0], 'function', 'and the factory returned a disposer')
})

// ── happy path ────────────────────────────────────────────────────────────
await check('health describes the endpoint without touching disk', async () => {
  const res = await call(handler, 'GET', '/api/doc-attach/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.extensions, ['.pdf', '.docx'])
  assert.equal(res.body.dropDirName, '.dsh-drops')
})

await check('a valid upload lands in the workspace drop directory byte-for-byte', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-1', name: 'report.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.equal(res.status, 200, `unexpected status: ${res.raw.slice(0, 200)}`)
  assert.ok(withinDrops(res.body.path), `landed outside the drop dir: ${res.body.path}`)
  assert.equal(res.body.name, 'report.pdf')
  assert.equal(res.body.bytes, PDF_BYTES.length)
  assert.ok(existsSync(res.body.path), 'the file exists')
  assert.deepEqual(readFileSync(res.body.path), PDF_BYTES, 'content is identical')
})

await check('the workspace may also be addressed by path', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspacePath: WORKSPACE, name: 'bypath.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.equal(res.status, 200, `unexpected status: ${res.raw.slice(0, 200)}`)
  assert.ok(existsSync(res.body.path))
})

await check('a session id resolves to its owning workspace (the browser path)', async () => {
  // This is the selector the client actually uses: it knows its session, and
  // the host derives the directory from the registry rather than a claim.
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    sessionId: 'session-abc', name: 'bysession.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.equal(res.status, 200, `unexpected status: ${res.raw.slice(0, 200)}`)
  assert.ok(withinDrops(res.body.path), `landed outside the drop dir: ${res.body.path}`)
})

await check('a session no workspace owns is refused', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    sessionId: 'session-nobody', name: 'orphan.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.equal(res.status, 403, `expected 403, got ${res.status}`)
})

await check('no selector at all is refused', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    name: 'nowhere.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.equal(res.status, 403)
})

await check('a repeated name never overwrites the earlier drop', async () => {
  const first = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-1', name: 'dup.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  const second = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-1', name: 'dup.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.notEqual(first.body.path, second.body.path, 'paths must differ')
  assert.equal(second.body.name, 'dup-1.pdf')
  assert.ok(existsSync(first.body.path) && existsSync(second.body.path), 'both survive')
})

// ── security boundary ─────────────────────────────────────────────────────
await check('a directory the host has not registered is refused', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspacePath: OUTSIDER, name: 'evil.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${res.raw.slice(0, 160)}`)
  assert.ok(!existsSync(join(OUTSIDER, '.dsh-drops')), 'nothing was written to the outsider dir')
})

await check('an unknown workspace id is refused', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-does-not-exist', name: 'x.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.equal(res.status, 403)
})

await check('a traversal name cannot escape the drop directory', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-1', name: '../../escaped.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  // The name is reduced to its basename, so the write stays inside the drop dir.
  assert.equal(res.status, 200, `unexpected status ${res.status}`)
  assert.ok(withinDrops(res.body.path), `escaped the drop dir: ${res.body.path}`)
  assert.equal(res.body.name, 'escaped.pdf')
  assert.ok(!existsSync(join(SANDBOX, 'escaped.pdf')), 'nothing landed above the workspace')
})

await check('a Windows-style traversal name cannot escape either', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-1', name: '..\\..\\escaped2.pdf', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.equal(res.status, 200)
  assert.ok(withinDrops(res.body.path), `escaped the drop dir: ${res.body.path}`)
})

await check('a name that is only dots is refused', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-1', name: '..', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.equal(res.status, 400)
})

await check('an unsupported extension is refused by name', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-1', name: 'payload.exe', dataBase64: PDF_BYTES.toString('base64'),
  })
  assert.equal(res.status, 400)
  assert.ok(res.body.error.includes('.exe'), res.body.error)
})

await check('a decoded payload over the limit is refused', async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 0x41)
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-1', name: 'big.pdf', dataBase64: big.toString('base64'),
  })
  assert.equal(res.status, 413, `expected 413, got ${res.status}`)
  assert.ok(!existsSync(join(DROPS, 'big.pdf')), 'the oversized file was not written')
})

await check('a request body over the wire cap is refused', async () => {
  const limited = buildHandler(
    { routePath: '/api/doc-attach', dropDirName: '.dsh-drops', extensions: ['.pdf'], maxBytes: 1 << 20, maxBodyBytes: 1024 },
    { webServer: {}, workspaceRegistry, logger: { warn() {} } },
  )
  const res = await call(limited, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-1', name: 'wire.pdf', dataBase64: Buffer.alloc(4096, 0x41).toString('base64'),
  })
  assert.equal(res.status, 413, `expected 413, got ${res.status}`)
})

// ── protocol handling ─────────────────────────────────────────────────────
await check('non-POST upload and non-GET health are 405', async () => {
  assert.equal((await call(handler, 'GET', '/api/doc-attach/upload')).status, 405)
  assert.equal((await call(handler, 'POST', '/api/doc-attach/health', {})).status, 405)
})

await check('an unknown subpath is 404', async () => {
  assert.equal((await call(handler, 'GET', '/api/doc-attach/nope')).status, 404)
})

await check('a malformed JSON body is 400, not a crash', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', '{not json', 'raw')
  assert.equal(res.status, 400)
})

await check('a payload decoding to zero bytes is 400', async () => {
  const res = await call(handler, 'POST', '/api/doc-attach/upload', {
    workspaceId: 'ws-1', name: 'empty.pdf', dataBase64: '',
  })
  assert.equal(res.status, 400)
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
rmSync(SANDBOX, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
