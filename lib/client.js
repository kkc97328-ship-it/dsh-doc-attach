/**
 * dsh-doc-attach — browser half.
 *
 * A drop/paste target, a file-card rail for the composer, and the upload call
 * that lands a document in the active session's workspace.
 *
 * NO SECOND DRAFT MODEL. On a successful upload the document's absolute path is
 * written into the composer draft as an `@` reference, so the agent receives it
 * through the ordinary prompt path and its own file tools can reach the same
 * file. The rail is then DERIVED from that draft: a card is visible exactly
 * while its `@path` token is present. That is what keeps the rail and the
 * prompt in agreement — deleting the reference by hand drops the card, and
 * removing a card is a one-line draft edit rather than a second bookkeeping
 * system that can disagree with what will actually be sent.
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
       * GENERATED from formats.json — this bundle is a classic script with no
       * module graph, so it cannot import the list. Images are NOT listed: they
       * belong to the harness's own image channel, which previews them and
       * sends them as image blocks, and this plugin deliberately does not
       * intercept them.
       */
      // BEGIN GENERATED:readable — source: formats.json; run `node scripts/sync-formats.mjs`
      var ACCEPTED = ['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx']
      // END GENERATED:readable — source: formats.json; run `node scripts/sync-formats.mjs`
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
       * Badge per container: the Office family colours, so the format is
       * readable from the card without parsing the extension.
       */
      var BADGES = {
        '.pdf': { label: 'PDF', colour: '#c0392b' },
        '.docx': { label: 'DOC', colour: '#2b579a' },
        '.doc': { label: 'DOC', colour: '#2b579a' },
        '.pptx': { label: 'PPT', colour: '#c4471f' },
        '.ppt': { label: 'PPT', colour: '#c4471f' },
        '.xlsx': { label: 'XLS', colour: '#217346' },
      }

      /** The badge for an extension, with a neutral fallback. */
      function badgeOf(extension) {
        var known = BADGES[extension]
        if (known !== undefined) return known
        var label = extension.replace('.', '').toUpperCase().slice(0, 3)
        return { label: label === '' ? 'FILE' : label, colour: '#6b7280' }
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
      function overlay(text) {
        return React.createElement('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 2147483000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.42)', backdropFilter: 'blur(2px)',
            color: '#fff', fontSize: 15, pointerEvents: 'none',
          },
        }, React.createElement('div', {
          style: {
            padding: '20px 28px', borderRadius: 14,
            border: '1px dashed rgba(255,255,255,0.55)',
            background: 'rgba(20,20,24,0.72)', textAlign: 'center', lineHeight: 1.7,
          },
        }, text))
      }

      /**
       * One attached document.
       *
       * The whole card is a flex row: a coloured format badge, two lines of
       * text that truncate rather than widen, and a remove control. `title`
       * carries the absolute path, because the visible name is only the last
       * path segment and two documents can share one.
       */
      function FileCard(props) {
        var doc = props.doc
        var badge = badgeOf(doc.ext)
        return React.createElement('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            minWidth: 150, maxWidth: 260, padding: '6px 8px',
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
            background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06))',
          },
          title: doc.path,
        }, [
          React.createElement('span', {
            key: 'badge',
            style: {
              flex: '0 0 auto', width: 34, height: 34, borderRadius: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: badge.colour, color: '#fff',
              fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
            },
          }, badge.label),
          React.createElement('div', {
            key: 'text',
            style: { minWidth: 0, flex: '1 1 auto', lineHeight: 1.35 },
          }, [
            React.createElement('div', {
              key: 'name',
              style: {
                fontSize: 12,
                color: 'var(--dsw-alias-label-primary, inherit)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, doc.name),
            React.createElement('div', {
              key: 'meta',
              style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)' },
            }, humanSize(doc.bytes) + ' · ' + doc.ext.replace('.', '').toUpperCase()),
          ]),
          React.createElement('button', {
            key: 'remove',
            type: 'button',
            onClick: function (event) {
              event.preventDefault()
              event.stopPropagation()
              props.onRemove(doc)
            },
            title: '移除',
            'aria-label': '移除 ' + doc.name,
            style: {
              flex: '0 0 auto', width: 20, height: 20, padding: 0,
              border: 'none', borderRadius: 6, cursor: 'pointer',
              lineHeight: '18px', fontSize: 14, background: 'transparent',
              color: 'var(--dsw-alias-label-secondary, #6b7280)',
            },
          }, '×'),
        ])
      }

      /**
       * The composer dock entry: a card rail plus a drag invitation.
       *
       * Reads only the session kit and the input snapshot it is handed, so it
       * holds no state the host must reconcile.
       */
      function DocumentDock(props) {
        var sessionId = props.sessionId
        var actions = props.inputActions
        var input = props.input

        var docsState = React.useState([])
        var docs = docsState[0]
        var setDocs = docsState[1]
        var statusState = React.useState(null)
        var status = statusState[0]
        var setStatus = statusState[1]
        var dragState = React.useState(false)
        var dragActive = dragState[0]
        var setDragActive = dragState[1]

        var draft = input && typeof input.draft === 'string' ? input.draft : ''

        // The draft is read at upload-completion time, which can be seconds
        // after the drop; a render-time snapshot would append to a stale draft
        // and silently discard whatever the user typed meanwhile.
        var draftRef = React.useRef('')
        draftRef.current = draft

        // A card lives exactly while its token is in the draft.
        var shown = docs.filter(function (doc) { return draft.indexOf(doc.token) >= 0 })

        /** Record one landed document, ignoring a repeat of the same path. */
        function remember(payload) {
          var token = '@' + payload.path
          setDocs(function (list) {
            if (list.some(function (item) { return item.token === token })) return list
            return list.concat([{
              token: token,
              path: payload.path,
              name: payload.name,
              bytes: payload.bytes,
              ext: extname(payload.name),
            }])
          })
        }

        /** Drop the card and its reference, leaving the rest of the draft intact. */
        function forget(doc) {
          setDocs(function (list) {
            return list.filter(function (item) { return item.token !== doc.token })
          })
          if (!actions) return
          var next = draftRef.current.split(doc.token).join('')
          next = next.replace(/[ \t]{2,}/g, ' ').replace(/^\s+/, '').replace(/\s+$/, '')
          actions.setDraft(next)
        }

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
          var failures = []
          var pending = documents.length
          documents.forEach(function (file) {
            upload(file, sessionId).then(function (payload) {
              remember(payload)
              actions.setDraft(withReference(draftRef.current, payload.path))
            }, function (error) {
              failures.push(file.name + '：' + error.message)
            }).then(function () {
              pending -= 1
              if (pending > 0) return
              // Success needs no sentence: the card appearing is the feedback.
              setStatus(failures.length > 0 ? { phase: 'error', message: failures.join('；') } : null)
            })
          })
        }

        var nodes = []
        if (dragActive) {
          nodes.push(React.createElement('div', { key: 'overlay' },
            overlay('松开即上传文档\n' + ACCEPTED.join(' / ') + '，上限 ' + humanSize(MAX_BYTES))))
        }
        if (shown.length > 0) {
          nodes.push(React.createElement('div', {
            key: 'rail',
            style: { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '2px 0' },
          }, shown.map(function (doc) {
            return React.createElement(FileCard, { key: doc.token, doc: doc, onRemove: forget })
          })))
        }
        if (status !== null) {
          nodes.push(React.createElement('div', {
            key: 'status',
            style: Object.assign({
              padding: '2px 2px', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap',
            }, status.phase === 'error'
              ? { color: 'var(--dsw-alias-state-error-primary, #d9534f)' }
              : { color: 'var(--dsw-alias-label-secondary, #6b7280)', opacity: 0.85 }),
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
              // The todo dock sits at 0 and the goal bar at 10. A document rail
              // belongs directly above the composer, so it takes a place between
              // them deterministically instead of relying on load order.
              order: 5,
            }, DocumentDock)
          })
        },
      }
    },
  })
})()
