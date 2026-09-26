/**
 * Verification for the dsh-doc-attach browser bundle.
 *
 * Run: node dsh-doc-attach/tests/test-client-bundle.mjs
 *
 * The bundle is loaded exactly as the client module system loads it — a
 * classic script that registers a factory — against a minimal stand-in for
 * the browser APIs it touches. That lets the whole drop -> upload -> draft
 * path be exercised here rather than discovered in a live page: this is the
 * newest and least proven code in the package, and the draft mutation is the
 * part that can silently corrupt what the user typed.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

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

// ── a minimal browser ─────────────────────────────────────────────────────
/** Listeners registered by the component, so events can be dispatched. */
const listeners = new Map()
/** Requests the bundle issued through fetch. */
const requests = []

/** Fake React: enough for function components with the hooks the bundle uses. */
function makeReact() {
  let slots = []
  let cursor = 0
  return {
    /** Reset hook cursor before each render. */
    __begin: () => { cursor = 0 },
    __slots: () => slots,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      const setter = (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
      }
      return [slots[index], setter]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect) {
      cursor += 1
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
}
/** Cleanups returned by useEffect, run between tests. */
let cleanups = []

function installBrowser(fetchImpl) {
  listeners.clear()
  requests.length = 0
  cleanups = []
  for (const cleanup of cleanups) cleanup()

  globalThis.window = {
    __ModuleLoader__: { load(config) { globalThis.__registered = config } },
    addEventListener(type, handler) { listeners.set(`window:${type}`, handler) },
    removeEventListener() {},
  }
  globalThis.document = {
    addEventListener(type, handler) { listeners.set(type, handler) },
    removeEventListener() {},
  }
  globalThis.btoa = (text) => Buffer.from(text, 'binary').toString('base64')
  globalThis.FileReader = class {
    readAsArrayBuffer() {
      this.result = new Uint8Array([1, 2, 3, 4]).buffer
      if (this.onload) this.onload()
    }
  }
  globalThis.fetch = (url, options) => {
    requests.push({ url, options })
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(fetchImpl(url, options)),
    })
  }
}

/** Load the bundle fresh and return the factory it registered. */
let loadCounter = 0
async function loadBundle() {
  globalThis.__registered = undefined
  await import(`${pathToFileURL(BUNDLE).href}?v=${loadCounter++}`)
  const config = globalThis.__registered
  assert.ok(config, 'the bundle registered a factory')
  return config
}

console.log('Client bundle verification')
console.log('')

// ── bundle contract ───────────────────────────────────────────────────────
await check('the bundle registers exactly one factory under the package id', async () => {
  installBrowser(() => ({ ok: true }))
  const config = await loadBundle()
  assert.equal(config.id, 'dsh-doc-attach', 'id must equal the package name')
  assert.equal(typeof config.factory, 'function')
  const React = makeReact()
  const plugin = config.factory((specifier) => {
    assert.equal(specifier, 'react', 'only react is requested from the module table')
    return React
  })
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

await check('apply() registers into the composer dock seat, satisfying the list contract', async () => {
  installBrowser(() => ({ ok: true }))
  const config = await loadBundle()
  const React = makeReact()
  const plugin = config.factory(() => React)
  const stub = makeSlotsStub()
  plugin.apply(stub.ctx)
  assert.deepEqual(stub.injected, ['conversation.input.dock'])
  assert.equal(stub.registrations.length, 1, 'exactly one registration')
  const options = stub.registrations[0].options
  assert.equal(options.name, 'conversation.input.dock')
  // `conversation.input.dock` is a LIST slot, and the registry throws without
  // a top-level id — a throw that fails the entire loader entry, not just this
  // registration. This is the assertion that was missing when the plugin
  // shipped a registration that could never apply.
  assert.equal(typeof options.id, 'string', 'list slot needs a top-level id')
  assert.ok(options.id.length > 0, 'the id must not be empty')
  assert.equal(options.id, 'dsh-doc-attach')
  assert.equal(typeof stub.registrations[0].component, 'function')
})

await check('the stub itself rejects a list registration with no top-level id', async () => {
  // Proves the stub is faithful rather than permissive: nesting `id` under an
  // `options` key leaves options.id undefined, which is the exact shape of the
  // defect that shipped.
  assert.throws(
    () => makeSlotsStub().ctx.slots.register({ name: 'conversation.input.dock' }, () => null),
    /requires options\.id/,
  )
  assert.throws(
    () => makeSlotsStub().ctx.slots.register(
      { name: 'conversation.input.dock', options: { id: 'dsh-doc-attach' } },
      () => null,
    ),
    /requires options\.id/,
  )
})

// ── the drop -> upload -> draft path ──────────────────────────────────────
/**
 * A slots registry stub that ENFORCES the real per-kind requirements instead of
 * accepting anything.
 *
 * A permissive stub is how a broken registration shipped: the suite passed
 * while the plugin could not load, because nothing in the harness ever applied
 * the rule `packages/client/ui-slots/src/index.ts` applies at line 814. The
 * validation here mirrors that switch statement, so the same defect cannot pass
 * again.
 *
 * @returns the stub context plus the registrations it accepted.
 */
function makeSlotsStub() {
  // The slot kinds this plugin registers into, mirrored from ui-conversation's
  // SlotMap. Declared inside the factory deliberately: this function is hoisted
  // and called from checks that run earlier in the file, where a module-level
  // `const` would still be in its temporal dead zone.
  const SLOT_KINDS = {
    'conversation.input.dock': 'list',
  }
  /** @type {{ options: any, component: any }[]} */
  const registrations = []
  /** @type {string[]} */
  const injected = []
  const entries = new Map()
  return {
    registrations,
    injected,
    ctx: {
      slots: {
        inject(name, factory) { injected.push(name); return factory() },
        register(options, component) {
          const priority = options.priority ?? 0
          const kind = SLOT_KINDS[options.name]
          // Mirrors ui-slots/src/index.ts:799-823.
          if (kind === 'list') {
            if (options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`)
            const cell = `${options.name}:${options.id}:${priority}`
            if (entries.has(cell)) throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}"`)
            entries.set(cell, true)
          } else if (kind === 'single') {
            if (entries.has(`${options.name}:${priority}`)) {
              throw new Error(`single slot "${options.name}" already has a registration`)
            }
            entries.set(`${options.name}:${priority}`, true)
          }
          registrations.push({ options, component })
          return () => {}
        },
      },
    },
  }
}

/** Build the component and render it once with the given props. */
function render(component, props, React) {
  React.__begin()
  return component(props)
}

/**
 * Mount the plugin against the enforcing stub and return the component it
 * registered. apply() itself returns nothing, so the registration has to be
 * captured on the way through the inject factory.
 */
function mount(plugin) {
  const stub = makeSlotsStub()
  plugin.apply(stub.ctx)
  assert.equal(stub.registrations.length, 1, 'exactly one slot registration')
  const component = stub.registrations[0].component
  assert.equal(typeof component, 'function', 'a component was registered')
  return component
}

await check('an idle dock renders nothing at all (costs no layout)', async () => {
  installBrowser(() => ({ ok: true }))
  const config = await loadBundle()
  const React = makeReact()
  const plugin = config.factory(() => React)
  const component = mount(plugin)
  const tree = render(component, { sessionId: 's1', inputActions: { setDraft() {} }, input: { draft: '' } }, React)
  assert.equal(tree, null)
})

await check('a dropped PDF is uploaded with the session id and appended to the draft', async () => {
  installBrowser(() => ({
    ok: true, path: 'D:\\ws\\.dsh-drops\\report.pdf', name: 'report.pdf', bytes: 4096,
  }))
  const config = await loadBundle()
  const React = makeReact()
  const plugin = config.factory(() => React)
  let drafts = []
  const component = mount(plugin)

  // Render once so the effect registers the document listeners.
  render(component, {
    sessionId: 'session-abc',
    inputActions: { setDraft(next) { drafts.push(next) } },
    input: { draft: '这份文档说了什么？' },
  }, React)

  const drop = listeners.get('drop')
  assert.equal(typeof drop, 'function', 'a drop listener is registered')
  drop({
    preventDefault() {},
    dataTransfer: { types: ['Files'], files: [{ name: 'report.pdf', size: 4096 }] },
  })

  // Let the upload promise chain settle.
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(requests.length, 1, 'exactly one upload request')
  assert.ok(requests[0].url.endsWith('/api/doc-attach/upload'), requests[0].url)
  const body = JSON.parse(requests[0].options.body)
  assert.equal(body.sessionId, 'session-abc', 'the session id is the only locator sent')
  assert.equal(body.name, 'report.pdf')
  assert.equal(typeof body.dataBase64, 'string')
  assert.ok(body.dataBase64.length > 0, 'the bytes were encoded')
  assert.equal('workspacePath' in body, false, 'the browser never names a write target')

  assert.equal(drafts.length, 1, 'the draft was written once')
  assert.ok(drafts[0].startsWith('这份文档说了什么？'), 'existing text is preserved')
  assert.ok(drafts[0].includes('@D:\\ws\\.dsh-drops\\report.pdf'), `path was appended: ${drafts[0]}`)
})

await check('a non-document drop is refused with a reason and sends nothing', async () => {
  installBrowser(() => ({ ok: true }))
  const config = await loadBundle()
  const React = makeReact()
  const plugin = config.factory(() => React)
  let drafts = []
  const component = mount(plugin)
  render(component, {
    sessionId: 's1', inputActions: { setDraft(n) { drafts.push(n) } }, input: { draft: '' },
  }, React)

  listeners.get('drop')({
    preventDefault() {},
    dataTransfer: { types: ['Files'], files: [{ name: 'malware.exe', size: 10 }] },
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requests.length, 0, 'nothing was uploaded')
  assert.equal(drafts.length, 0, 'the draft was not touched')
})

await check('a failed upload leaves the draft untouched and reports the error', async () => {
  installBrowser(() => ({ ok: false, error: 'unsupported extension ".pdf"' }))
  const config = await loadBundle()
  const React = makeReact()
  const plugin = config.factory(() => React)
  let drafts = []
  const component = mount(plugin)
  const tree = render(component, {
    sessionId: 's1', inputActions: { setDraft(n) { drafts.push(n) } }, input: { draft: '' },
  }, React)

  listeners.get('drop')({
    preventDefault() {},
    dataTransfer: { types: ['Files'], files: [{ name: 'report.pdf', size: 10 }] },
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(drafts.length, 0, 'a failed upload must not claim success in the draft')

  // Re-render: the hook slot now holds the error status, and it is rendered.
  const after = render(component, {
    sessionId: 's1', inputActions: { setDraft() {} }, input: { draft: '' },
  }, React)
  assert.ok(after !== null, 'an error status renders a line')
  assert.ok(JSON.stringify(after).includes('unsupported extension'), JSON.stringify(after).slice(0, 200))
})

await check('pasting a document is accepted like a drop', async () => {
  installBrowser(() => ({ ok: true, path: 'D:\\ws\\.dsh-drops\\pasted.pdf', name: 'pasted.pdf', bytes: 8 }))
  const config = await loadBundle()
  const React = makeReact()
  const plugin = config.factory(() => React)
  let drafts = []
  const component = mount(plugin)
  render(component, {
    sessionId: 's1', inputActions: { setDraft(n) { drafts.push(n) } }, input: { draft: '' },
  }, React)

  const paste = listeners.get('paste')
  assert.equal(typeof paste, 'function', 'a paste listener is registered')
  let prevented = false
  paste({
    preventDefault() { prevented = true },
    clipboardData: { files: [{ name: 'pasted.pdf', size: 8 }] },
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requests.length, 1, 'the pasted document was uploaded')
  assert.equal(prevented, true, 'the paste was consumed, not also typed into the box')
  assert.ok(drafts[0].includes('pasted.pdf'), drafts[0])
})

await check('pasting a screenshot is left to the image channel', async () => {
  installBrowser(() => ({ ok: true }))
  const config = await loadBundle()
  const React = makeReact()
  const plugin = config.factory(() => React)
  const component = mount(plugin)
  render(component, {
    sessionId: 's1', inputActions: { setDraft() {} }, input: { draft: '' },
  }, React)

  let prevented = false
  listeners.get('paste')({
    preventDefault() { prevented = true },
    clipboardData: { files: [{ name: 'screenshot.png', size: 2048 }] },
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(prevented, false, 'the image paste must not be swallowed')
  assert.equal(requests.length, 0, 'and must not be uploaded here')
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
