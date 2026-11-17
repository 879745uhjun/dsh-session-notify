// Host harness for dsh-session-notify.
//
// Drives the real Host plugin through stubbed Cordis services: the browser
// routes, the durable watch file, and the finished-turn trigger. The card
// launcher is observed through the `spawn` seam, so no window appears.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { apply, name } from '../index.js'

/** A Host context stub that captures the web routes and the event listeners. */
function createHost(home, config, spawned, options = {}) {
  const advertise = options.advertise ?? 'http://127.0.0.1:49823'
  // null means "no session service in this composition", so every id is accepted.
  const knownSessions = options.knownSessions ?? null
  const routes = new Map()
  const listeners = new Map()
  const ctx = {
    get: (key) => {
      if (key === 'dshHomePath') return (suffix) => join(home.dir, suffix)
      if (key === 'webApp' && advertise !== '') return { getAdvertisedUrl: () => advertise }
      if (key === 'sessions' && knownSessions !== null) {
        return { get: (id) => (knownSessions.includes(id) ? { id } : undefined) }
      }
      return undefined
    },
    effect: (factory) => {
      factory()
    },
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    inject: (services, run) => {
      const scope = {
        webServer: {
          register(route) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        },
        effect: (factory) => {
          factory()
        },
      }
      run(scope)
    },
  }
  const seams = {
    spawn(command, args, options) {
      spawned.push({ command, args, options })
      return { on() {}, unref() {} }
    },
  }
  apply(ctx, config, seams)
  return { routes, listeners }
}

/** One response stub that keeps the status, headers, and body. */
function createResponse() {
  const chunks = []
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.statusCode = status
      Object.assign(response.headers, headers ?? {})
      return response
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk))
      response.body = Buffer.concat(chunks).toString('utf8')
      return true
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      response.body = Buffer.concat(chunks).toString('utf8')
    },
    destroy() {},
    on() {},
  }
  return response
}

/** One request stub carrying a JSON body. */
function createRequest(method, body, headers = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  request.method = method
  request.headers = { host: '127.0.0.1:64133', ...headers }
  return request
}

/** Call one route handler and return its decoded response. */
async function call(handler, method, body, headers) {
  const response = createResponse()
  await handler(createRequest(method, body === undefined ? undefined : JSON.stringify(body), headers), response)
  return { status: response.statusCode, headers: response.headers, json: response.body === '' ? null : JSON.parse(response.body) }
}

/** A fresh temporary home directory per test. */
function createHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'session-notify-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, file: join(dir, 'session-notify.json') }
}

/** Fire one durable session event at the registered listener. */
async function fireTurnEnd(host, sessionId, kind = 'completed') {
  const listener = host.listeners.get('session/event')
  assert.ok(listener, 'session/event listener is registered')
  await listener({ id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind } } })
}

test('exports the plugin name', () => {
  assert.equal(name, 'dsh-session-notify')
})

test('registers the watch route, the event stream, the sample route, and the open route', (t) => {
  const home = createHome(t)
  const spawned = []
  const host = createHost(home, {}, spawned)
  assert.deepEqual([...host.routes.keys()].sort(), [
    '/session-notify',
    '/session-notify/events',
    '/session-notify/open',
    '/session-notify/test',
    '/session-notify/watch',
  ])
})

test('watch, list, and unwatch round-trip through the durable file', async (t) => {
  const home = createHome(t)
  const spawned = []
  const host = createHost(home, {}, spawned)
  const route = host.routes.get('/session-notify')

  const empty = await call(route, 'GET')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json.watched, {})

  const watched = await call(route, 'POST', { action: 'watch', sessionId: 'session-a', title: '大学俄语', locale: 'zh' })
  assert.equal(watched.status, 200)
  assert.equal(watched.json.watching, true)
  assert.equal(watched.json.watched['session-a'].title, '大学俄语')
  assert.equal(watched.json.watched['session-a'].locale, 'zh')

  const stored = JSON.parse(readFileSync(home.file, 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.watched['session-a'].title, '大学俄语')

  const listed = await call(route, 'GET')
  assert.deepEqual(Object.keys(listed.json.watched), ['session-a'])

  const removed = await call(route, 'POST', { action: 'unwatch', sessionId: 'session-a' })
  assert.equal(removed.json.watching, false)
  assert.deepEqual(removed.json.watched, {})
  assert.deepEqual(JSON.parse(readFileSync(home.file, 'utf8')).watched, {})
})

test('a watched structure survives a Host restart', async (t) => {
  const home = createHome(t)
  const first = createHost(home, {}, [])
  await call(first.routes.get('/session-notify'), 'POST', { action: 'watch', sessionId: 'session-b', title: 'Keep me', locale: 'en' })

  // A second apply simulates the next app start over the same home directory.
  const second = createHost(home, {}, [])
  const listed = await call(second.routes.get('/session-notify'), 'GET')
  assert.equal(listed.json.watched['session-b'].title, 'Keep me')
  assert.equal(listed.json.watched['session-b'].locale, 'en')
})

test('rejects a cross-origin caller and a malformed mutation', async (t) => {
  const home = createHome(t)
  const host = createHost(home, {}, [])
  const route = host.routes.get('/session-notify')

  const crossSite = await call(route, 'POST', { action: 'watch', sessionId: 'session-a' }, { origin: 'http://evil.example' })
  assert.equal(crossSite.status, 403)

  const noId = await call(route, 'POST', { action: 'watch' })
  assert.equal(noId.status, 400)

  const unknown = await call(route, 'POST', { action: 'ring', sessionId: 'session-a' })
  assert.equal(unknown.status, 400)

  const method = await call(route, 'PUT')
  assert.equal(method.status, 405)
})

test('a finished turn on a watched session raises one card', async (t) => {
  const home = createHome(t)
  const spawned = []
  const host = createHost(home, { durationMs: 5000 }, spawned)
  await call(host.routes.get('/session-notify'), 'POST', { action: 'watch', sessionId: 'session-a', title: '语法总纲', locale: 'zh' })

  await fireTurnEnd(host, 'session-a')
  assert.equal(spawned.length, 1)

  const { command, args, options } = spawned[0]
  assert.match(command, /powershell\.exe$/i)
  const value = (flag) => args[args.indexOf(flag) + 1]
  assert.match(value('-File'), /popup\.ps1$/)
  assert.equal(value('-Title'), '语法总纲')
  assert.equal(value('-Body'), '此对话已结束')
  assert.equal(value('-Accent'), 'done')
  assert.equal(value('-DurationMs'), '5000')
  assert.equal(value('-OpenUrl'), 'http://127.0.0.1:49823/session-notify/open')
  assert.equal(value('-OpenSession'), 'session-a')
  assert.match(value('-Meta'), /^已完成 · \d{1,2}:\d{2} · 点击打开对话$/)
  assert.equal(options.windowsHide, true)
  assert.equal(options.stdio, 'ignore')
})

test('an unwatched session, a non-turn event, and a second trigger stay quiet', async (t) => {
  const home = createHome(t)
  const spawned = []
  const host = createHost(home, {}, spawned)
  await call(host.routes.get('/session-notify'), 'POST', { action: 'watch', sessionId: 'session-a', title: 'A', locale: 'zh' })

  await fireTurnEnd(host, 'session-b')
  assert.equal(spawned.length, 0)

  const listener = host.listeners.get('session/event')
  await listener({ id: 'session-a' }, { type: 'assistant/message', data: {} })
  assert.equal(spawned.length, 0)

  await fireTurnEnd(host, 'session-a')
  await fireTurnEnd(host, 'session-a')
  assert.equal(spawned.length, 1)
})

test('every turn outcome keeps the same sentence and only moves the accent', async (t) => {
  const home = createHome(t)
  const spawned = []
  const host = createHost(home, {}, spawned)
  const route = host.routes.get('/session-notify')
  for (const id of ['done-session', 'aborted-session', 'error-session']) {
    await call(route, 'POST', { action: 'watch', sessionId: id, title: id, locale: 'zh' })
  }

  await fireTurnEnd(host, 'done-session', 'completed')
  await fireTurnEnd(host, 'aborted-session', 'aborted')
  await fireTurnEnd(host, 'error-session', 'error')
  assert.equal(spawned.length, 3)

  const value = (args, flag) => args[args.indexOf(flag) + 1]
  assert.deepEqual(spawned.map((entry) => value(entry.args, '-Body')), ['此对话已结束', '此对话已结束', '此对话已结束'])
  assert.deepEqual(spawned.map((entry) => value(entry.args, '-Accent')), ['done', 'warn', 'error'])
  assert.match(value(spawned[0].args, '-Meta'), /^已完成 · /)
  assert.match(value(spawned[1].args, '-Meta'), /^已中断 · /)
  assert.match(value(spawned[2].args, '-Meta'), /^出错 · /)
})

test('the turn outcome picks the accent and the language', async (t) => {
  const home = createHome(t)
  const spawned = []
  const host = createHost(home, {}, spawned)
  const route = host.routes.get('/session-notify')
  await call(route, 'POST', { action: 'watch', sessionId: 'zh-session', title: '中文', locale: 'zh' })
  await call(route, 'POST', { action: 'watch', sessionId: 'en-session', title: 'English', locale: 'en-US' })

  await fireTurnEnd(host, 'zh-session', 'error')
  await fireTurnEnd(host, 'en-session', 'aborted')

  const value = (args, flag) => args[args.indexOf(flag) + 1]
  assert.equal(value(spawned[0].args, '-Accent'), 'error')
  assert.equal(value(spawned[0].args, '-Body'), '此对话已结束')
  assert.equal(value(spawned[1].args, '-Accent'), 'warn')
  assert.equal(value(spawned[1].args, '-Body'), 'This conversation has finished')
  assert.match(value(spawned[1].args, '-Meta'), /^Stopped · \d{1,2}:\d{2} · Click to open this conversation$/)
})

test('disabled config keeps the watch list but draws nothing', async (t) => {
  const home = createHome(t)
  const spawned = []
  const host = createHost(home, { enabled: false }, spawned)
  await call(host.routes.get('/session-notify'), 'POST', { action: 'watch', sessionId: 'session-a', title: 'A', locale: 'zh' })
  await fireTurnEnd(host, 'session-a')
  assert.equal(spawned.length, 0)
})

test('sticky config reaches the script', async (t) => {
  const home = createHome(t)
  const spawned = []
  const host = createHost(home, { sticky: true }, spawned)
  await call(host.routes.get('/session-notify'), 'POST', { action: 'watch', sessionId: 'session-a', title: 'A', locale: 'zh' })
  await fireTurnEnd(host, 'session-a')
  assert.ok(spawned[0].args.includes('-Sticky'))
})

test('the sample route draws one card in the caller language', async (t) => {
  const home = createHome(t)
  const spawned = []
  const host = createHost(home, {}, spawned)
  const route = host.routes.get('/session-notify/test')

  const zh = await call(route, 'POST', { locale: 'zh', title: '试一下', sessionId: 'session-a' })
  assert.equal(zh.status, 200)
  assert.equal(zh.json.shown, true)
  assert.equal(zh.json.body, '此对话已结束')
  const value = (flag) => spawned[0].args[spawned[0].args.indexOf(flag) + 1]
  assert.equal(value('-Title'), '试一下')
  assert.equal(value('-OpenSession'), 'session-a', 'the sample card can jump too')
  assert.match(value('-Meta'), /点击打开对话$/)

  const en = await call(route, 'POST', {})
  assert.equal(en.json.body, '此对话已结束', 'an omitted locale keeps the Chinese default')
  assert.equal(spawned[1].args.includes('-OpenSession'), false, 'no session id, no jump')

  const rejected = await call(route, 'GET')
  assert.equal(rejected.status, 405)
})

test('a click on the card reaches every open window as a navigate frame', async (t) => {
  const home = createHome(t)
  const host = createHost(home, {}, [])
  const stream = createResponse()
  await host.routes.get('/session-notify/events')(createRequest('GET'), stream)
  // The stream subscribes after its first load; give that a turn.
  for (let attempt = 0; attempt < 40 && !stream.body.includes('event: watched'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.match(stream.body, /event: watched/)

  const opened = await call(host.routes.get('/session-notify/open'), 'POST', { sessionId: 'session-a' })
  assert.equal(opened.status, 200)
  assert.equal(opened.json.delivered, 1)
  assert.match(stream.body, /event: navigate\ndata: \{"ok":true,"sessionId":"session-a"\}/)
})

test('the open route rejects a bad caller and a missing session id', async (t) => {
  const home = createHome(t)
  const host = createHost(home, {}, [])
  const route = host.routes.get('/session-notify/open')

  const crossSite = await call(route, 'POST', { sessionId: 'session-a' }, { origin: 'http://evil.example' })
  assert.equal(crossSite.status, 403)

  const noId = await call(route, 'POST', {})
  assert.equal(noId.status, 400)

  const wrongMethod = await call(route, 'GET')
  assert.equal(wrongMethod.status, 405)
})

test('a composition without a page keeps the card dismiss-only', async (t) => {
  const home = createHome(t)
  const spawned = []
  const host = createHost(home, {}, spawned, { advertise: '' })
  await call(host.routes.get('/session-notify'), 'POST', { action: 'watch', sessionId: 'session-a', title: 'A', locale: 'zh' })
  await fireTurnEnd(host, 'session-a')

  assert.equal(spawned[0].args.includes('-OpenUrl'), false)
  const value = (flag) => spawned[0].args[spawned[0].args.indexOf(flag) + 1]
  assert.match(value('-Meta'), /点击关闭$/)
})

/** Attach one fake SSE client and wait for its first snapshot frame. */
async function attachStream(host) {
  const stream = createResponse()
  await host.routes.get('/session-notify/events')(createRequest('GET'), stream)
  for (let attempt = 0; attempt < 40 && !stream.body.includes('event: watched'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.match(stream.body, /event: watched/, 'the stream sent its opening snapshot')
  return stream
}

/** How many change frames of one kind the stream carried. */
function frameCount(stream, kind) {
  return (stream.body.match(new RegExp('"kind":"' + kind + '"', 'g')) ?? []).length
}

test('another plugin can watch and unwatch a session through the watch route', async (t) => {
  const home = createHome(t)
  const host = createHost(home, {}, [], { knownSessions: ['session-a'] })
  const stream = await attachStream(host)
  const watch = host.routes.get('/session-notify/watch')

  const on = await call(watch, 'POST', { sessionId: 'session-a', on: true })
  assert.equal(on.status, 200)
  assert.deepEqual(on.json, { ok: true, sessionId: 'session-a', watching: true })

  const listed = await call(host.routes.get('/session-notify'), 'GET')
  assert.deepEqual(Object.keys(listed.json.watched), ['session-a'], 'GET shows the watch')
  assert.equal(frameCount(stream, 'watch'), 1, 'the change reached every open window')

  const off = await call(watch, 'POST', { sessionId: 'session-a', on: false })
  assert.deepEqual(off.json, { ok: true, sessionId: 'session-a', watching: false })
  const afterOff = await call(host.routes.get('/session-notify'), 'GET')
  assert.deepEqual(afterOff.json.watched, {})
  assert.equal(frameCount(stream, 'unwatch'), 1)
})

test('repeating the same watch request writes and publishes once', async (t) => {
  const home = createHome(t)
  const host = createHost(home, {}, [], { knownSessions: ['session-a'] })
  const stream = await attachStream(host)
  const watch = host.routes.get('/session-notify/watch')

  const first = await call(watch, 'POST', { sessionId: 'session-a', on: true })
  const second = await call(watch, 'POST', { sessionId: 'session-a', on: true })
  assert.equal(first.json.watching, true)
  assert.deepEqual(second.json, first.json, 'the answer is stable')
  assert.equal(frameCount(stream, 'watch'), 1, 'a repeated request publishes nothing new')

  await call(watch, 'POST', { sessionId: 'session-a', on: false })
  await call(watch, 'POST', { sessionId: 'session-a', on: false })
  assert.equal(frameCount(stream, 'unwatch'), 1, 'unwatching twice publishes nothing new')
})

test('the watch route uses the same watch file as the sidebar menu', async (t) => {
  const home = createHome(t)
  const host = createHost(home, {}, [], { knownSessions: ['session-a', 'session-b'] })

  await call(host.routes.get('/session-notify'), 'POST', { action: 'watch', sessionId: 'session-a', title: '菜单会话', locale: 'zh' })
  await call(host.routes.get('/session-notify/watch'), 'POST', { sessionId: 'session-b', on: true })

  const stored = JSON.parse(readFileSync(home.file, 'utf8'))
  assert.deepEqual(Object.keys(stored.watched).sort(), ['session-a', 'session-b'])
  assert.equal(stored.watched['session-a'].title, '菜单会话', 'the menu keeps its write path')

  // The menu can still turn off a watch a caller created.
  const removed = await call(host.routes.get('/session-notify'), 'POST', { action: 'unwatch', sessionId: 'session-b' })
  assert.equal(removed.json.watching, false)
})

test('an unknown session id is answered, not written', async (t) => {
  const home = createHome(t)
  const host = createHost(home, {}, [], { knownSessions: ['session-a'] })
  const watch = host.routes.get('/session-notify/watch')

  const unknown = await call(watch, 'POST', { sessionId: 'session-ghost', on: true })
  assert.equal(unknown.status, 200)
  assert.deepEqual(unknown.json, { ok: true, sessionId: 'session-ghost', watching: false, reason: 'unknown-session' })

  const listed = await call(host.routes.get('/session-notify'), 'GET')
  assert.deepEqual(listed.json.watched, {}, 'nothing was stored for an unknown id')
})

test('the watch route validates its input and its caller', async (t) => {
  const home = createHome(t)
  const host = createHost(home, {}, [], { knownSessions: ['session-a'] })
  const watch = host.routes.get('/session-notify/watch')

  const crossSite = await call(watch, 'POST', { sessionId: 'session-a', on: true }, { origin: 'http://evil.example' })
  assert.equal(crossSite.status, 403)

  const noOn = await call(watch, 'POST', { sessionId: 'session-a' })
  assert.equal(noOn.status, 400)

  const badOn = await call(watch, 'POST', { sessionId: 'session-a', on: 'yes' })
  assert.equal(badOn.status, 400)

  const noId = await call(watch, 'POST', { on: true })
  assert.equal(noId.status, 400)

  const wrongMethod = await call(watch, 'GET')
  assert.equal(wrongMethod.status, 405)

  const listed = await call(host.routes.get('/session-notify'), 'GET')
  assert.deepEqual(listed.json.watched, {}, 'a rejected request changes nothing')
})
