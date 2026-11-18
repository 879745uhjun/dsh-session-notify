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
/** Mutable page theme the bundle reads, plus the observers it installs. */
const page = { dark: false, observers: [] }
globalThis.MutationObserver = class {
  constructor(callback) {
    this.callback = callback
    page.observers.push(this)
  }

  observe() {}

  disconnect() {}
}
globalThis.document = {
  visibilityState: 'visible',
  body: {
    hasAttribute: (name) => (name === 'data-ds-dark-theme' ? page.dark : false),
  },
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

/** Clipboard the self-test's copy button writes into. */
const clipboard = []
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text) => { clipboard.push(text) } } },
    configurable: true,
  })
} catch {
  globalThis.navigator.clipboard = { writeText: async (text) => { clipboard.push(text) } }
}

/* -------------------------------------------------------------------------- *
 * Hook shim: enough React for these components, no renderer
 * -------------------------------------------------------------------------- */

let frame = null
const frames = new Map()

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
    // Capture the owner: a state update can land after the render that created
    // it (the section's async run does exactly that).
    const owner = frame
    const index = owner.index++
    if (!(index in owner.hooks)) owner.hooks[index] = typeof initial === 'function' ? initial() : initial
    return [owner.hooks[index], (next) => {
      owner.hooks[index] = typeof next === 'function' ? next(owner.hooks[index]) : next
    }]
  },
  useEffect(effect) {
    const owner = frame
    const index = owner.index++
    owner.hooks[index] = effect()
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
function render(component, props, key) {
  const outer = frame
  let shared
  if (key === undefined) {
    shared = { hooks: [], index: 0 }
  } else {
    shared = frames.get(key) ?? { hooks: [], index: 0 }
    frames.set(key, shared)
    shared.index = 0
  }
  frame = shared
  try {
    // Wrapper components stay in the same frame, so a stateful component's hooks
    // survive the manual re-render this harness does.
    let node = component(props)
    while (node !== null && typeof node === 'object' && typeof node.type === 'function') {
      node = node.type(node.props)
    }
    return materialize(node)
  } finally {
    frame = outer
  }
}

/** The first element carrying `attr` with one of the given values. */
function byAttr(tree, attr, ...values) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return undefined
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = byAttr(child, attr, ...values)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (values.length === 0 ? tree.props?.[attr] !== undefined : values.includes(tree.props?.[attr])) return tree
  return byAttr(tree.props?.children, attr, ...values)
}

/** Every element carrying `attr`. */
function allByAttr(tree, attr) {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node.props?.[attr] !== undefined) found.push(node)
    walk(node.props?.children)
  }
  walk(tree)
  return found
}

/** Wait until `probe` returns something truthy. */
async function waitFor(probe, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + label)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
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
  const requests = []
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
    let body
    try {
      body = init.body === undefined ? undefined : JSON.parse(init.body)
    } catch {
      body = init.body
    }
    requests.push({ path, body })
    const response = createResponse()
    await handler(createRequest(init.method ?? 'GET', init.body), response)
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      json: async () => JSON.parse(response.body),
    }
  }
  return { routes, requests }
}

/* -------------------------------------------------------------------------- *
 * Client context stub
 * -------------------------------------------------------------------------- */

const SLOTS = {
  row: 'sidebar.session.row.trailing',
  icon: 'contextMenu.icon',
  section: 'plugins.detail.section',
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
    entry: (id) => entries.find((entry) => entry.options.id === id),
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

  assert.deepEqual(client.injected, [SLOTS.section, SLOTS.row, SLOTS.icon, SLOTS.icon, SLOTS.icon])
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

test('the page reports its DSH theme so the card can match it', async (t) => {
  page.dark = false
  page.observers.length = 0
  const host = await mountHost(t, [])
  await mountClient()
  await settle()

  const reported = () => host.requests.filter((entry) => entry.path === '/session-notify/theme').map((entry) => entry.body?.theme)
  assert.deepEqual(reported(), ['light'], 'a light page reports light without asking the OS')

  page.dark = true
  for (const observer of page.observers) observer.callback([])
  await settle()
  assert.deepEqual(reported(), ['light', 'dark'], 'flipping data-ds-dark-theme reports dark')
})

test('an English page keeps the menu and the Host card in English', async (t) => {  const spawned = []
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

/* -------------------------------------------------------------------------- *
 * Self-test section
 * -------------------------------------------------------------------------- */

const MINE = { kind: 'bundle', pkg: { name: 'dsh-session-notify' } }
let selfTestRuns = 0

/** Render the section, press 运行自检, answer the stream, and wait until it settles. */
async function runSelfTest(client, options = {}) {
  const subject = options.subject ?? MINE
  const timeoutMs = options.timeoutMs ?? 800
  const entry = client.entry('dsh-session-notify.selftest')
  const before = sources.length
  // A fresh hook frame per invocation: a hung run must not leak its state into
  // the next case.
  selfTestRuns += 1
  const key = 'selftest-' + selfTestRuns
  const view = () => render(entry.component, { subject, timeoutMs }, key)

  byAttr(view(), 'data-selftest-action', 'run').props.onClick()
  if (options.answerStream !== false) {
    const stream = await waitFor(() => (sources.length > before ? sources[sources.length - 1] : undefined), 'the self-test stream')
    stream.listeners.get('watched')?.({ data: JSON.stringify({ ok: true, watched: {} }) })
  }
  const tree = await waitFor(() => {
    const next = view()
    const rows = allByAttr(next, 'data-check')
    return rows.length === 4 && rows.every((row) => row.props['data-status'] !== 'run') ? next : undefined
  }, 'the self-test to settle')
  return {
    tree,
    rows: allByAttr(tree, 'data-check').map((row) => ({ id: row.props['data-check'], status: row.props['data-status'] })),
    summary: byAttr(tree, 'data-selftest-summary').props['data-selftest-summary'],
  }
}

test('the self-test is registered for this plugin page only', async (t) => {
  const host = await mountHost(t, [])
  const client = await mountClient()
  await settle()

  const entry = client.entry('dsh-session-notify.selftest')
  assert.ok(entry, 'the section is registered')
  assert.equal(entry.options.name, 'plugins.detail.section')
  assert.equal(entry.options.order, 90)

  assert.equal(render(entry.component, { subject: { kind: 'bundle', pkg: { name: 'dsh-session-todos' } } }), null,
    'another plugin page stays clean')
  assert.equal(render(entry.component, { subject: { kind: 'item', id: 'dsh-session-notify' } }), null,
    'an official-plugin subject renders nothing')
  assert.ok(render(entry.component, { subject: MINE }), 'its own page renders the section')

  const before = host.requests.length
  render(entry.component, { subject: MINE })
  assert.equal(host.requests.length, before, 'rendering the section runs no check by itself')
})

test('a healthy plugin reports every check as passed', async (t) => {
  await mountHost(t, [])
  const client = await mountClient()
  await settle()

  const { rows, summary } = await runSelfTest(client)
  assert.deepEqual(rows, [
    { id: 'route', status: 'pass' },
    { id: 'events', status: 'pass' },
    { id: 'card', status: 'pass' },
    { id: 'theme', status: 'pass' },
  ])
  assert.equal(summary, '4 通过 · 0 失败 · 0 跳过')
})

test('one broken route fails alone and the rest still pass', async (t) => {
  await mountHost(t, [])
  const client = await mountClient()
  await settle()

  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => (String(url).includes('/session-notify/theme')
    ? { ok: false, status: 500, json: async () => ({}) }
    : real(url, init))
  t.after(() => {
    globalThis.fetch = real
  })

  const { rows, tree } = await runSelfTest(client)
  assert.deepEqual(rows.map((row) => row.status), ['pass', 'pass', 'pass', 'fail'])
  const detail = allByAttr(tree, 'data-check').find((row) => row.props['data-check'] === 'theme')
  assert.equal(detail.props['data-status'], 'fail')
})

test('a hanging request fails after the budget and the section still renders', async (t) => {
  await mountHost(t, [])
  const client = await mountClient()
  await settle()

  const real = globalThis.fetch
  // Real fetch rejects on abort; the stub must too, or the budget never fires.
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
  })
  t.after(() => {
    globalThis.fetch = real
  })

  const { rows, tree } = await runSelfTest(client, { timeoutMs: 60, answerStream: false })
  assert.deepEqual(rows.map((row) => row.status), ['fail', 'skip', 'fail', 'fail'])
  assert.ok(byAttr(tree, 'data-selftest-action', 'run'), 'the section is still usable')
})

test('复制结果 writes the Markdown the spec asks for', async (t) => {
  await mountHost(t, [])
  const client = await mountClient()
  await settle()

  const { tree } = await runSelfTest(client)
  clipboard.length = 0
  byAttr(tree, 'data-selftest-action', 'copy').props.onClick()
  const [text] = await waitFor(() => (clipboard.length > 0 ? clipboard : undefined), 'the clipboard text')
  const lines = text.split('\n')
  assert.equal(lines.length, 4)
  assert.match(lines[0], /^- \[x\] 后台路由（GET \/session-notify） — 通过$/)
  assert.match(lines[3], /^- \[x\] 主题端点（\/session-notify\/theme） — 通过$/)
})
