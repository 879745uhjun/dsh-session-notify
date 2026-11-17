// Browser-half harness for dsh-session-notify.
//
// The shipped client bundle is loaded for real: its module loader call is
// captured, the returned plugin is applied to a stub Client context, and the
// contribution and slot components are driven directly. `fetch` is routed into
// the real Host plugin instead of the network, so every assertion covers the
// Client/Host contract — the session-menu submenu, the row bell, the sample
// card, and a clicked card opening its conversation.
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
  request.headers = { host: '127.0.0.1:49823' }
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
  icon: 'contextMenu.icon',
}

let imports = 0

/** Build one Client context, apply the bundle, and return what it registered. */
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
  const contributions = []
  const notices = []
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
  const contextMenus = {
    register(contribution) {
      contributions.push(contribution)
      return () => {}
    },
    notify(text, success) {
      notices.push({ text, success })
    },
  }
  const ctx = {
    contextMenus,
    effect: (factory) => factory(),
    get: (name) => {
      if (name === 'sessions') return { list: catalog }
      if (name === 'locale') return locale
      if (name === 'contextMenus') return contextMenus
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
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'contextMenus'])
  plugin.apply(ctx)

  return {
    entries,
    contributions,
    injected,
    language,
    notices,
    opened,
    source: sources[sources.length - 1],
    bySlot: (slot) => entries.filter((entry) => entry.options.name === slot),
  }
}

/** Let the initial fetch, toggles, and refreshes settle. */
async function settle() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Resolve the session-menu entries for one session, as the shared menu does. */
async function resolveMenu(client, displayTitle = '语法总纲') {
  const contribution = client.contributions[0]
  assert.ok(contribution, 'a session-menu contribution is registered')
  const actions = await contribution.resolve({ sessionId: 'session-a', displayTitle }, new AbortController().signal)
  return { contribution, actions }
}

const noEvent = { preventDefault() {}, stopPropagation() {} }

/* -------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------- */

test('the bundle registers its style, dictionaries, stream, bell, icons, and menu', async (t) => {
  await mountHost(t, [])
  const client = await mountClient()
  await settle()

  assert.deepEqual(client.injected, [SLOTS.row, SLOTS.icon, SLOTS.icon, SLOTS.icon])
  assert.equal(client.bySlot(SLOTS.row).length, 1)
  assert.deepEqual(client.bySlot(SLOTS.icon).map((entry) => entry.options.key), [
    'session-notify.bell',
    'session-notify.bell-on',
    'session-notify.download',
  ])
  assert.equal(client.contributions.length, 1)
  assert.ok(styleElements.some((style) => style.attributes['data-plugin-css'] === 'dsh-session-notify/SessionNotify.css'))
  assert.ok(sources.some((source) => source.url === '/session-notify/events'), 'the live watch stream is opened')
})

test('one session-menu row carries the two original actions as a submenu', async (t) => {
  await mountHost(t, [])
  const client = await mountClient()
  await settle()

  const { contribution, actions } = await resolveMenu(client)
  assert.equal(contribution.target, 'session')
  assert.equal(contribution.order, 460)
  assert.equal(actions.length, 1, 'one row, not two')

  const parent = actions[0]
  assert.equal(parent.id, 'settings')
  assert.equal(parent.label, '会话提醒设置')
  assert.deepEqual(parent.icon, { key: 'session-notify.bell' })
  assert.equal(parent.run, undefined, 'the parent only opens its submenu')
  assert.deepEqual(parent.children.map((child) => child.id), ['toggle', 'preview'])
  assert.deepEqual(parent.children.map((child) => child.label), ['结束时提醒', '试弹一次提醒'])
  assert.equal(parent.children[1].icon.key, 'session-notify.download')
})

test('the toggle child watches and unwatches through the Host', async (t) => {
  const spawned = []
  await mountHost(t, spawned)
  const client = await mountClient()
  await settle()

  const { actions } = await resolveMenu(client)
  await actions[0].children[0].run()
  await settle()
  assert.deepEqual(client.notices.at(-1), { text: '已开启这个会话的结束提醒', success: true })

  const afterOn = await resolveMenu(client)
  assert.equal(afterOn.actions[0].label, '会话提醒设置 · 开', 'the parent shows the state')
  assert.equal(afterOn.actions[0].children[0].label, '已开启结束时提醒')
  assert.deepEqual(afterOn.actions[0].icon, { key: 'session-notify.bell-on' })

  await afterOn.actions[0].children[0].run()
  await settle()
  assert.deepEqual(client.notices.at(-1), { text: '已关闭这个会话的结束提醒', success: true })
  const afterOff = await resolveMenu(client)
  assert.equal(afterOff.actions[0].label, '会话提醒设置')
  assert.equal(spawned.length, 0, 'toggling alone never draws a card')
})

test('the row bell appears only for a watched session and turns it off', async (t) => {
  await mountHost(t, [])
  const client = await mountClient()
  await settle()
  const bell = client.bySlot(SLOTS.row)[0].component

  assert.equal(render(bell, { sessionId: 'session-a' }), null, 'no bell while the session is not watched')

  const watching = await resolveMenu(client)
  await watching.actions[0].children[0].run()
  await settle()

  const buttonElement = button(render(bell, { sessionId: 'session-a' }))
  assert.ok(buttonElement, 'the watched session shows a bell')
  assert.equal(buttonElement.props['aria-label'], '已开启结束时提醒，点击关闭')
  assert.equal(render(bell, { sessionId: 'session-b' }), null, 'other rows stay clean')

  buttonElement.props.onClick(noEvent)
  await settle()
  assert.equal(render(bell, { sessionId: 'session-a' }), null, 'clicking the bell turns the watch off')
})

test('the preview child asks the Host for one card with the session title', async (t) => {
  const spawned = []
  const host = await mountHost(t, spawned)
  const client = await mountClient()
  await settle()

  const { actions } = await resolveMenu(client)
  await actions[0].children[1].run()
  await settle()

  assert.equal(host.routes.has('/session-notify/test'), true)
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

test('an English page keeps the menu and the Host card in English', async (t) => {
  const spawned = []
  await mountHost(t, spawned)
  const client = await mountClient()
  client.language.active = 'en'
  await settle()

  const { actions } = await resolveMenu(client, 'English session')
  assert.equal(actions[0].label, 'Session notifications')
  assert.deepEqual(actions[0].children.map((child) => child.label), [
    'Notify when this session finishes',
    'Show a sample notification',
  ])

  await actions[0].children[1].run()
  await settle()
  const value = (flag) => spawned[0].args[spawned[0].args.indexOf(flag) + 1]
  assert.equal(value('-Body'), 'This conversation has finished')
  assert.equal(value('-Meta').includes('Click to open this conversation'), true)
})
