/**
 * dsh-doc-attach — browser half.
 *
 * A drop/paste target and status line for the composer, and the upload call
 * that lands a document in the active session's workspace. It deliberately
 * does NOT build a separate attachment draft model: on a successful upload the
 * document's absolute path is written into the composer draft as an `@`
 * reference, so the agent receives it through the ordinary prompt path and its
 * own file tools can reach the same file. Fewer moving parts, and no second
 * source of truth about what the user has attached.
 *
 * Bundle contract (packages/client/modules/README.md): a classic script that
 * only REGISTERS a factory. Every side effect lives in the factory closure and
 * runs at materialization — so React is taken through the provided `require`,
 * and nothing touches the page until the plugin is materialized.
 */
(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-doc-attach',
    factory: function (require) {
      var React = require('react')

      /** Keep in step with the host row's `routePath` in cordis.patch.yml. */
      var ROUTE = '/api/doc-attach'
      /**
       * Keep in step with the host rows' `extensions` / READABLE set
       * (guarded by tests/test-extension-consistency.mjs). Images are NOT
       * listed: they belong to the harness's own image channel, which previews
       * them and sends them as image blocks, and this plugin deliberately does
       * not intercept them.
       */
      var ACCEPTED = ['.pdf', '.docx', '.doc', '.pptx', '.ppt']
      /** Client-side courtesy cap; the host enforces the authoritative one. */
      var MAX_BYTES = 64 * 1024 * 1024

      /** Lowercase extension of a file name, including the dot. */
      function extname(name) {
        var index = String(name).lastIndexOf('.')
        return index < 0 ? '' : String(name).slice(index).toLowerCase()
      }

      /** Whether this file is one the host will accept. */
      function acceptable(file) {
        return ACCEPTED.indexOf(extname(file.name)) >= 0
      }

      /** Human-readable size. */
      function humanSize(bytes) {
        if (bytes < 1024) return bytes + ' B'
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
        return (bytes / 1048576).toFixed(1) + ' MB'
      }

      /**
       * Encode bytes as base64 in chunks. A single fromCharCode apply over a
       * large document would blow the argument limit, hence the chunking.
       */
      function toBase64(buffer) {
        var bytes = new Uint8Array(buffer)
        var chunk = 0x8000
        var parts = []
        for (var offset = 0; offset < bytes.length; offset += chunk) {
          parts.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk)))
        }
        return btoa(parts.join(''))
      }

      /** Read a File as an ArrayBuffer. */
      function readBuffer(file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader()
          reader.onerror = function () { reject(new Error('could not read ' + file.name)) }
          reader.onload = function () { resolve(reader.result) }
          reader.readAsArrayBuffer(file)
        })
      }

      /**
       * Send one document to the host. The session id is the only locator the
       * client supplies: the host derives the destination directory from its
       * own workspace registry, so a browser cannot name a write target.
       */
      function upload(file, sessionId) {
        return readBuffer(file).then(function (buffer) {
          return fetch(ROUTE + '/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: sessionId,
              name: file.name,
              dataBase64: toBase64(buffer),
            }),
          }).then(function (response) {
            return response.json().then(function (payload) {
              if (!response.ok || payload.ok !== true) {
                throw new Error(payload && payload.error ? payload.error : 'upload failed (' + response.status + ')')
              }
              return payload
            })
          })
        })
      }

      /** Append one `@path` reference to the current draft, never clobbering it. */
      function withReference(draft, path) {
        var token = '@' + path
        if (draft.indexOf(token) >= 0) return draft
        if (draft === '') return token + ' '
        return draft.replace(/\s+$/, '') + ' ' + token + ' '
      }

      /** The full-viewport invitation shown while a file drag is over the page. */
      function overlay(React_, text) {
        return React_.createElement('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 2147483000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.42)', backdropFilter: 'blur(2px)',
            color: '#fff', fontSize: 15, pointerEvents: 'none',
          },
        }, React_.createElement('div', {
          style: {
            padding: '20px 28px', borderRadius: 14,
            border: '1px dashed rgba(255,255,255,0.55)',
            background: 'rgba(20,20,24,0.72)', textAlign: 'center', lineHeight: 1.7,
          },
        }, text))
      }

      /**
       * The composer dock entry. Reads only the session kit and the input
       * snapshot it is handed, so it holds no state the host must reconcile.
       */
      function DocumentDock(props) {
        var sessionId = props.sessionId
        var actions = props.inputActions
        var input = props.input
        var statusState = React.useState(null)
        var status = statusState[0]
        var setStatus = statusState[1]
        var dragState = React.useState(false)
        var dragActive = dragState[0]
        var setDragActive = dragState[1]

        // The draft is read at upload-completion time, which can be seconds
        // after the drop; a render-time snapshot would append to a stale draft
        // and silently discard whatever the user typed meanwhile.
        var draftRef = React.useRef('')
        draftRef.current = input && typeof input.draft === 'string' ? input.draft : ''

        React.useEffect(function () {
          var depth = 0
          function carriesFiles(event) {
            var transfer = event.dataTransfer
            return transfer !== null && transfer !== undefined
              && transfer.types && transfer.types.indexOf('Files') >= 0
          }
          function onDragEnter(event) {
            if (!carriesFiles(event)) return
            event.preventDefault()
            depth += 1
            setDragActive(true)
          }
          function onDragOver(event) {
            if (!carriesFiles(event)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
          function onDragLeave(event) {
            if (!carriesFiles(event)) return
            depth = Math.max(0, depth - 1)
            if (depth === 0) setDragActive(false)
          }
          function reset() { depth = 0; setDragActive(false) }
          function onDrop(event) {
            if (!carriesFiles(event)) return
            event.preventDefault()
            reset()
            intake(Array.prototype.slice.call(event.dataTransfer.files || []))
          }
          function onPaste(event) {
            var items = event.clipboardData && event.clipboardData.files
            if (!items || items.length === 0) return
            var files = Array.prototype.slice.call(items)
            var documents = files.filter(acceptable)
            if (documents.length === 0) return
            event.preventDefault()
            intake(documents)
          }
          document.addEventListener('dragenter', onDragEnter)
          document.addEventListener('dragover', onDragOver)
          document.addEventListener('dragleave', onDragLeave)
          document.addEventListener('drop', onDrop)
          document.addEventListener('paste', onPaste)
          window.addEventListener('dragend', reset)
          return function () {
            document.removeEventListener('dragenter', onDragEnter)
            document.removeEventListener('dragover', onDragOver)
            document.removeEventListener('dragleave', onDragLeave)
            document.removeEventListener('drop', onDrop)
            document.removeEventListener('paste', onPaste)
            window.removeEventListener('dragend', reset)
          }
        }, [sessionId])

        /** Accept a batch, reporting anything refused rather than dropping it. */
        function intake(files) {
          if (!sessionId || !actions) return
          var documents = []
          var refused = []
          for (var i = 0; i < files.length; i += 1) {
            var file = files[i]
            if (!acceptable(file)) { refused.push(file.name + '（暂只支持 ' + ACCEPTED.join(' / ') + '）'); continue }
            if (file.size > MAX_BYTES) { refused.push(file.name + ' 超过 ' + humanSize(MAX_BYTES)); continue }
            documents.push(file)
          }
          if (refused.length > 0) setStatus({ phase: 'error', message: refused.join('；') })
          if (documents.length === 0) return
          setStatus({ phase: 'busy', message: '正在上传 ' + documents.length + ' 个文档…' })
          var done = []
          var failures = []
          var pending = documents.length
          documents.forEach(function (file) {
            upload(file, sessionId).then(function (payload) {
              done.push(payload)
              actions.setDraft(withReference(draftRef.current, payload.path))
            }, function (error) {
              failures.push(file.name + '：' + error.message)
            }).then(function () {
              pending -= 1
              if (pending > 0) return
              if (failures.length > 0) {
                setStatus({ phase: 'error', message: failures.join('；') })
              } else {
                setStatus({
                  phase: 'ok',
                  message: '已加入 ' + done.map(function (item) { return item.name + '（' + humanSize(item.bytes) + '）' }).join('、'),
                })
              }
            })
          })
        }

        var nodes = []
        if (dragActive) {
          nodes.push(overlay(React, '松开即上传文档\n' + ACCEPTED.join(' / ') + '，上限 ' + humanSize(MAX_BYTES)))
        }
        if (status !== null) {
          var palette = status.phase === 'error'
            ? { color: 'var(--dsw-alias-text-danger, #d9534f)' }
            : status.phase === 'ok'
              ? { color: 'var(--dsw-alias-text-secondary, #6b7280)' }
              : { color: 'var(--dsw-alias-text-secondary, #6b7280)', opacity: 0.8 }
          nodes.push(React.createElement('div', {
            key: 'status',
            style: Object.assign({
              padding: '2px 4px', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap',
            }, palette),
          }, status.message))
        }
        if (nodes.length === 0) return null
        return React.createElement('div', null, nodes)
      }

      return {
        inject: ['slots'],
        apply: function (ctx) {
          ctx.slots.inject('conversation.input.dock', function () {
            // `conversation.input.dock` is a LIST slot, and the registry keys
            // list entries by (id, priority): it throws when id is missing, and
            // that throw fails the whole loader entry, not just this
            // registration. `id` is a TOP-LEVEL option — nesting it (e.g.
            // `{ name, options: { id } }`) leaves options.id undefined and
            // reproduces the same failure.
            return ctx.slots.register({
              name: 'conversation.input.dock',
              id: 'dsh-doc-attach',
            }, DocumentDock)
          })
        },
      }
    },
  })
})()
