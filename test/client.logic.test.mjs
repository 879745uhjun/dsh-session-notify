// Browser-half harness for dsh-session-notify.
//
// The shipped client bundle is loaded for real: its module loader call is
// captured, the returned plugin is applied to a stub Client context, and the
// registered slot components are driven with a minimal hook shim. `fetch` is
// routed into the real Host plugin instead of the network, so every assertion
// covers the Client/Host contract — the watch toggle, the row bell, and the
// sample-card request.
//
// This is a logic harness, not a DOM test: there is no renderer here, so
// layout, focus, and visual appearance stay for the installed page to prove.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

/* -------------------------------------------------------------------------- *
 * Minimal browser surface, installed before the bundle is imported
 * -------------------------------------------------------------------------- */

const styleElements = []
globalThis.document = {
  visibilityState: 'visible',
  head: {
    appendChild(node) {
      styleElements.push(node)
      node.isConnected = true
    },
  },
  createElement(tag) {
    return {
      tag,
      attributes: {},
      textContent: '',
      isConnected: false,
      setAttribute(name, value) {
        this.attributes[name] = value
      },
      remove() {
        this.isConnected = false
      },
    }
  },
  addEventListener() {},
  removeEventListener() {},
}

const sources = []
class EventSourceStub {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    sources.push(this)
  }

  addEventListener(name, handler) {
    this.listeners.set(name, handler)
  }

  removeEventListener(name) {
    this.listeners.delete(name)
  }

  close() {
    this.closed = true
  }
}
globalThis.EventSource = EventSourceStub

/* -------------------------------------------------------------------------- *
 * Hook shim: enough React for these components, no renderer
 * -------------------------------------------------------------------------- */

let frame = null

function withFrame(run) {
  const outer = frame
  frame = { hooks: [], index: 0 }
  try {
    return run()
  } finally {
    frame = outer
  }
}

const React = {
  createElement(type, props, ...children) {
    const list = children.length <= 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: list } }
  },
  useState(initial) {
    const index = frame.index++
    if (!(index in frame.hooks)) frame.hooks[index] = typeof initial === 'function' ? initial() : initial
    return [frame.hooks[index], (next) => {
      frame.hooks[index] = typeof next === 'function' ? next(frame.hooks[index]) : next
    }]
  },
  useEffect(effect) {
    const index = frame.index++
    frame.hooks[index] = effect()
  },
}

/** Evaluate every function component in a tree, leaving plain elements. */
function materialize(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(materialize)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    return withFrame(() => materialize(node.type(node.props)))
  }
  return { ...node, props: { ...node.props, children: materialize(node.props.children) } }
}

/** Render one registered slot component and return its tree. */
function render(component, props) {
  return materialize(withFrame(() => component(props)))
}

/** The first `<button>` in a rendered tree. */
function button(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return undefined
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = button(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (tree.type === 'button') return tree
  return button(tree.props?.children)
}

/** The text of one element: its direct string child. */
function textOf(element) {
  return typeof element?.props?.children === 'string' ? element.props.children : ''
}

/* -------------------------------------------------------------------------- *
 * Real Host behind a fake fetch
 * -------------------------------------------------------------------------- */

/** One response stub for the Host route handlers. */
function createResponse() {
  const chunks = []
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      Object.assign(this.headers, headers ?? {})
      return this
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      this.body = Buffer.concat(chunks).toString('utf8')
    },
    destroy() {},
    on() {},
  }
}

function createRequest(method, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  request.method = method
  request.headers = { host: '127.0.0.1:64133' }
  return request
}

/** Mount the Host half over a temporary home and wire `fetch` into its routes. */
async function mountHost(t, spawned) {
  const home = mkdtempSync(join(tmpdir(), 'session-notify-client-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const routes = new Map()
  const { apply } = await import('../index.js')
  apply({
    get: (key) => {
      if (key === 'dshHomePath') return (suffix) => join(home, suffix)
      if (key === 'webApp') return { getAdvertisedUrl: () => 'http://127.0.0.1:49823' }
      return undefined
    },
    effect: (factory) => {
      factory()
    },
    on: () => () => {},
    inject: (services, run) => {
      run({
        webServer: {
          register(route) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        },
        effect: (factory) => {
          factory()
        },
      })
    },
  }, {}, {
    spawn(command, args) {
      spawned.push({ command, args })
      return { on() {}, unref() {} }
    },
  })

  globalThis.fetch = async (url, init = {}) => {
    const path = new URL('http://host' + url).pathname
    const handler = routes.get(path)
    if (handler === undefined) throw new Error('no route for ' + path)
    const response = createResponse()
    await handler(createRequest(init.method ?? 'GET', init.body), response)
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      json: async () => JSON.parse(response.body),
    }
  }
  return { routes }
}

/* -------------------------------------------------------------------------- *
 * Client context stub
 * -------------------------------------------------------------------------- */

const SLOTS = {
  row: 'sidebar.session.row.trailing',
  menu: 'sidebar.workspaces.session.menu.item',
}

let imports = 0

/** Build one Client context, apply the bundle, and return its slot entries. */
async function mountClient() {
  const captured = {}
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured.definition = definition
      },
    },
  }
  // A fresh query string gives each mount its own module instance, so the
  // bundle's module-level store starts empty per test.
  imports += 1
  await import('../client.js?mount=' + imports)
  assert.equal(captured.definition.id, 'dsh-session-notify')

  const dictionaries = new Map()
  const entries = []
  const injected = []
  const opened = []
  const catalog = {
    getSnapshot: () => ({ ids: ['session-a'], byId: { 'session-a': { id: 'session-a', title: '语法总纲', running: false } } }),
    subscribe: () => () => {},
  }
  const language = { active: 'zh' }
  const locale = {
    register(ns, dicts) {
      dictionaries.set(ns, dicts)
      return () => dictionaries.delete(ns)
    },
    bind: (ns) => (key, params) => {
      const template = dictionaries.get(ns)?.[language.active]?.[key] ?? key
      return params === undefined
        ? template
        : template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    },
    getSnapshot: () => ({ active: language.active, revision: 1 }),
    subscribe: () => () => {},
  }
  const ctx = {
    effect: (factory) => factory(),
    get: (name) => {
      if (name === 'sessions') return { list: catalog }
      if (name === 'locale') return locale
      if (name === 'uiWorkspace') return { openSession: (sessionId) => opened.push(sessionId) }
      return undefined
    },
    locale,
    slots: {
      inject(slot, register) {
        injected.push(slot)
        register()
      },
      register(options, component) {
        entries.push({ options, component })
        return () => {}
      },
    },
  }

  const plugin = captured.definition.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected module: ' + name)
  })
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  plugin.apply(ctx)

  return {
    entries,
    injected,
    language,
    opened,
    source: sources[sources.length - 1],
    bySlot: (slot) => entries.filter((entry) => entry.options.name === slot),
    entry: (id) => entries.find((entry) => entry.options.id === id),
  }
}

/** Let the initial fetch, toggles, and refreshes settle. */
async function settle() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const noEvent = { preventDefault() {}, stopPropagation() {} }

/* -------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------- */

test('the bundle registers its slots, its style, its dictionaries, and the stream', async (t) => {
  await mountHost(t, [])
  const client = await mountClient()
  await settle()
  assert.deepEqual(client.injected, [SLOTS.row, SLOTS.menu, SLOTS.menu])
  assert.equal(client.bySlot(SLOTS.row).length, 1)
  assert.equal(client.bySlot(SLOTS.menu).length, 2)
  assert.ok(styleElements.some((style) => style.attributes['data-plugin-css'] === 'dsh-session-notify/SessionNotify.css'))
  assert.ok(sources.some((source) => source.url === '/session-notify/events'), 'the live watch stream is opened')
})

test('the menu toggles one session on and off through the Host', async (t) => {
  const spawned = []
  await mountHost(t, spawned)
  const client = await mountClient()
  await settle()
  const watchItem = client.entry('session-notify-watch')
  assert.ok(watchItem, 'the watch menu entry is registered')

  let menu = true
  const first = button(render(watchItem.component, { sessionId: 'session-a', useMenuOpenState: () => [menu, (value) => { menu = value }] }))
  assert.equal(textOf(first.props.children[1]), '结束时提醒')
  assert.equal(textOf(first.props.children[2]), '关')

  first.props.onClick(noEvent)
  await settle()
  assert.equal(menu, false, 'the menu closes when the toggle is used')

  const watched = button(render(watchItem.component, { sessionId: 'session-a', useMenuOpenState: () => [false, () => {}] }))
  assert.equal(textOf(watched.props.children[1]), '已开启结束时提醒')
  assert.equal(textOf(watched.props.children[2]), '开')

  watched.props.onClick(noEvent)
  await settle()
  const off = button(render(watchItem.component, { sessionId: 'session-a', useMenuOpenState: () => [false, () => {}] }))
  assert.equal(textOf(off.props.children[1]), '结束时提醒')
  assert.equal(spawned.length, 0, 'watching a session does not draw a card by itself')
})

test('the row bell appears only for a watched session and turns it off', async (t) => {
  await mountHost(t, [])
  const client = await mountClient()
  await settle()
  const bell = client.bySlot(SLOTS.row)[0].component

  assert.equal(render(bell, { sessionId: 'session-a' }), null, 'no bell while the session is not watched')

  const watchItem = client.entry('session-notify-watch').component
  button(render(watchItem, { sessionId: 'session-a', useMenuOpenState: () => [true, () => {}] })).props.onClick(noEvent)
  await settle()

  const buttonElement = button(render(bell, { sessionId: 'session-a' }))
  assert.ok(buttonElement, 'the watched session shows a bell')
  assert.equal(buttonElement.props['aria-label'], '已开启结束时提醒，点击关闭')
  assert.equal(render(bell, { sessionId: 'session-b' }), null, 'other rows stay clean')

  buttonElement.props.onClick(noEvent)
  await settle()
  assert.equal(render(bell, { sessionId: 'session-a' }), null, 'clicking the bell turns the watch off')
})

test('the sample entry asks the Host for one card with the row title', async (t) => {
  const spawned = []
  const host = await mountHost(t, spawned)
  const client = await mountClient()
  await settle()
  const preview = client.entry('session-notify-preview').component

  const item = button(render(preview, { sessionId: 'session-a', useMenuOpenState: () => [false, () => {}] }))
  assert.equal(textOf(item.props.children[1]), '试弹一次提醒')
  assert.equal(host.routes.has('/session-notify/test'), true)
  item.props.onClick(noEvent)
  await settle()

  assert.equal(spawned.length, 1, 'the Host launched the card once')
  const value = (flag) => spawned[0].args[spawned[0].args.indexOf(flag) + 1]
  assert.equal(value('-Title'), '语法总纲')
  assert.equal(value('-Body'), '此对话已结束')
  assert.equal(value('-OpenSession'), 'session-a', 'clicking the sample card jumps to this session')
})

test('a clicked card opens its conversation through the workspace', async (t) => {
  await mountHost(t, [])
  const client = await mountClient()
  await settle()
  assert.ok(client.source, 'the event stream is open')

  const navigate = client.source.listeners.get('navigate')
  assert.ok(navigate, 'the bundle listens for a card click')

  navigate({ data: JSON.stringify({ ok: true, sessionId: 'session-a' }) })
  assert.deepEqual(client.opened, ['session-a'])

  navigate({ data: 'not json' })
  navigate({ data: JSON.stringify({ ok: false, sessionId: 'session-a' }) })
  assert.deepEqual(client.opened, ['session-a'], 'a malformed frame changes nothing')
})

test('an English page keeps the Host card in English', async (t) => {
  const spawned = []
  await mountHost(t, spawned)
  const client = await mountClient()
  client.language.active = 'en'
  await settle()
  const preview = client.entry('session-notify-preview').component
  const item = button(render(preview, { sessionId: 'session-a', useMenuOpenState: () => [false, () => {}] }))
  assert.equal(textOf(item.props.children[1]), 'Show a sample notification')
  item.props.onClick(noEvent)
  await settle()
  const value = (flag) => spawned[0].args[spawned[0].args.indexOf(flag) + 1]
  assert.equal(value('-Body'), 'This conversation has finished')
  assert.equal(value('-Meta').includes('Click to open this conversation'), true)
})
