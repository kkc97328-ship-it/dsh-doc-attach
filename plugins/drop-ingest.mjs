/**
 * dsh-doc-attach host half — the browser upload endpoint.
 *
 * The browser holds the bytes; only the host can put them on disk where the
 * agent's own file tools can reach them. This plugin owns one HTTP prefix
 * route for that handoff.
 *
 * Why an HTTP route instead of the harness RPC: exposing a host method to the
 * browser normally requires the Typert `@Remote` generated contract, and the
 * set of mountable remotes is fixed at build time by the shipped
 * `@deepseek-ai/dsh-web-app` bundle — a third-party plugin cannot add one.
 * `ctx.webServer.register` is the general route registry the harness itself
 * uses for every feature route, so it is the seam a plugin may legitimately
 * claim.
 *
 * Security posture. The server has no auth and is loopback-only by default,
 * so this endpoint must not become an arbitrary file-write primitive:
 *   - the destination directory must be a workspace the host itself has
 *     registered (canonical path compared against `workspaceRegistry.list()`),
 *     never a path the caller merely asserts;
 *   - the file name is reduced to a basename, so no traversal can survive;
 *   - only known document extensions are accepted;
 *   - the body is capped before it is decoded.
 * Nothing here trusts client-supplied paths for the write target.
 */
import { createHash } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'

export const name = 'dsh-doc-attach-drop'
/** The route registry is required; the workspace registry is the safety anchor. */
export const inject = ['webServer', 'workspaceRegistry']

const DEFAULT_CONFIG = {
  /** Prefix route this plugin claims; must be unique in the composition. */
  routePath: '/api/doc-attach',
  /** Subdirectory created inside the workspace for landed documents. */
  dropDirName: '.dsh-drops',
  /**
   * Accepted extensions. Keep in step with `read-document.mjs`'s READABLE set
   * and the browser bundle's ACCEPTED list (guarded by
   * `tests/test-extension-consistency.mjs`).
   */
  extensions: ['.pdf', '.docx', '.doc', '.pptx', '.ppt'],
  /** Decoded upload ceiling. */
  maxBytes: 64 * 1024 * 1024,
  /** Request body ceiling (base64 inflates the wire form). */
  maxBodyBytes: 96 * 1024 * 1024,
}

/** Extensions to accept, normalized to lowercase with a leading dot. */
function normalizeExtensions(list) {
  const out = []
  for (const raw of list ?? []) {
    const text = String(raw).trim().toLowerCase()
    if (text === '') continue
    out.push(text.startsWith('.') ? text : `.${text}`)
  }
  return out
}

/**
 * Reduce a caller-supplied name to a safe file name.
 * @param {string} raw - name as submitted, possibly with a path.
 * @param {string[]} allowed - accepted extensions.
 * @returns {{ name: string } | { problem: string }} a safe name, or why not.
 */
function safeName(raw, allowed) {
  const text = String(raw ?? '').replace(/\\/g, '/')
  if (text.trim() === '') return { problem: 'name is required' }
  const base = basename(text).trim()
  if (base === '' || base === '.' || base === '..') return { problem: 'name has no file component' }
  if (base.includes('/') || base.includes('\\') || base.includes(sep)) {
    return { problem: 'name must not contain a path separator' }
  }
  // Control characters and Windows-reserved characters would produce an
  // unopenable file; the caller can rename rather than get a mystery failure.
  if (/[\u0000-\u001f<>:"|?*]/.test(base)) return { problem: 'name contains characters a file name cannot carry' }
  const ext = extname(base).toLowerCase()
  if (!allowed.includes(ext)) {
    return { problem: `unsupported extension "${ext || '(none)'}"; accepted: ${allowed.join(', ')}` }
  }
  return { name: base }
}

/**
 * Pick a non-colliding path so repeated drops never overwrite an earlier one.
 * @param {string} dir - destination directory.
 * @param {string} name - safe file name.
 * @returns {Promise<string>} an unused absolute path.
 */
async function uniquePath(dir, name) {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = join(dir, name)
  let counter = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${counter}${ext}`)
    counter += 1
  }
  return candidate
}

/**
 * Read a request body with a hard ceiling.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} limit - byte ceiling.
 * @returns {Promise<{ body: string } | { tooLarge: true }>} the body or the cap signal.
 */
function readBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        // Stop buffering immediately; the handler answers 413.
        req.destroy()
        resolvePromise({ tooLarge: true })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolvePromise({ body: Buffer.concat(chunks).toString('utf8') }) })
    req.on('error', reject)
  })
}

/** Send one JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Build the request handler for one configuration.
 * @param {object} cfg - resolved configuration.
 * @param {object} deps - `{ webServer, workspaceRegistry, logger }`.
 * @returns {(req: any, res: any) => Promise<void>} the route handler.
 */
function buildHandler(cfg, deps) {
  const allowed = normalizeExtensions(cfg.extensions)

  /**
   * Canonical workspace roots the host itself has registered. A caller-supplied
   * id, path, or session is only usable when it maps onto one of these.
   */
  async function approvedRoots() {
    const roots = []
    for (const workspace of deps.workspaceRegistry.list()) {
      let canonical = workspace.path
      try { canonical = await realpath(workspace.path) } catch { /* keep the recorded path */ }
      let sessionIds = []
      try { sessionIds = [...(workspace.sessionIds ?? [])].map(String) } catch { /* optional getter */ }
      roots.push({ id: String(workspace.id), canonical, title: workspace.title, sessionIds })
    }
    return roots
  }

  /**
   * Resolve the destination directory, or explain why it is refused.
   *
   * A session id is the preferred selector: the browser knows which session it
   * is in, and the host derives the directory from its own registry rather
   * than from anything the caller asserts.
   */
  async function resolveDestination(workspaceId, workspacePath, sessionId) {
    const roots = await approvedRoots()
    let canonical
    if (sessionId !== undefined && sessionId !== '') {
      const owner = roots.find(root => root.sessionIds.includes(String(sessionId)))
      if (owner === undefined) return { problem: `no registered workspace owns session ${sessionId}` }
      canonical = owner.canonical
    } else if (workspaceId !== undefined && workspaceId !== '') {
      const found = roots.find(root => root.id === String(workspaceId))
      if (found === undefined) return { problem: `unknown workspace id: ${workspaceId}` }
      canonical = found.canonical
    } else if (workspacePath !== undefined && workspacePath !== '') {
      let resolved
      try {
        resolved = await realpath(resolve(String(workspacePath)))
      } catch (error) {
        return { problem: `workspace path is not readable: ${error.message}` }
      }
      const match = roots.some(root => root.canonical === resolved)
      if (!match) return { problem: 'that directory is not a registered workspace' }
      canonical = resolved
    } else {
      return { problem: 'sessionId, workspaceId, or workspacePath is required' }
    }
    const dir = join(canonical, cfg.dropDirName)
    // Belt and braces: the joined path must still sit under the workspace.
    if (!resolve(dir).startsWith(resolve(canonical))) {
      return { problem: 'refusing to write outside the workspace' }
    }
    return { dir, workspace: canonical }
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const subpath = url.pathname.slice(cfg.routePath.length) || '/'

    if (subpath === '/health' || subpath === '/') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        route: cfg.routePath,
        extensions: allowed,
        dropDirName: cfg.dropDirName,
        maxBytes: cfg.maxBytes,
      })
      return
    }

    if (subpath !== '/upload') {
      sendJson(res, 404, { ok: false, error: `unknown endpoint: ${subpath}` })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }

    const read = await readBody(req, cfg.maxBodyBytes)
    if (read.tooLarge === true) {
      sendJson(res, 413, { ok: false, error: `body exceeds ${cfg.maxBodyBytes} bytes` })
      return
    }

    let payload
    try {
      payload = JSON.parse(read.body)
    } catch {
      sendJson(res, 400, { ok: false, error: 'body must be JSON' })
      return
    }

    const named = safeName(payload.name, allowed)
    if ('problem' in named) {
      sendJson(res, 400, { ok: false, error: named.problem })
      return
    }

    let bytes
    try {
      bytes = Buffer.from(String(payload.dataBase64 ?? ''), 'base64')
    } catch {
      sendJson(res, 400, { ok: false, error: 'dataBase64 is not valid base64' })
      return
    }
    if (bytes.length === 0) {
      sendJson(res, 400, { ok: false, error: 'dataBase64 decoded to zero bytes' })
      return
    }
    if (bytes.length > cfg.maxBytes) {
      sendJson(res, 413, { ok: false, error: `${bytes.length} bytes exceeds the ${cfg.maxBytes} byte limit` })
      return
    }

    const destination = await resolveDestination(payload.workspaceId, payload.workspacePath, payload.sessionId)
    if ('problem' in destination) {
      sendJson(res, 403, { ok: false, error: destination.problem })
      return
    }

    try {
      await mkdir(destination.dir, { recursive: true })
      const target = await uniquePath(destination.dir, named.name)
      await writeFile(target, bytes)
      sendJson(res, 200, {
        ok: true,
        path: target,
        name: basename(target),
        bytes: bytes.length,
        // Returned so the client can show the same digest the agent will see.
        sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
        workspace: destination.workspace,
      })
    } catch (error) {
      deps.logger?.warn?.(`dsh-doc-attach: write failed for ${named.name}: ${error.message}`)
      sendJson(res, 500, { ok: false, error: `could not write the file: ${error.message}` })
    }
  }
}

/**
 * Register the upload route.
 * @param {object} ctx - owning Cordis context.
 * @param {object} [config] - plugin configuration overriding {@link DEFAULT_CONFIG}.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const handler = buildHandler(cfg, {
    webServer: ctx.webServer,
    workspaceRegistry: ctx.workspaceRegistry,
    logger: ctx.logger,
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: cfg.routePath, handler }),
    'dsh-doc-attach: register upload route',
  )
  ctx.logger?.info?.(`dsh-doc-attach: upload route mounted at ${cfg.routePath}`)
}

/** Exported for tests: build the handler without a live Cordis context. */
export { buildHandler, safeName, uniquePath, readBody }
