/**
 * dsh-session-notify — Host half.
 *
 * Notifies the desktop when a watched conversation finishes a turn: a
 * borderless card appears in the bottom-right corner of the screen and says
 * "此对话已结束" (or "This conversation has finished").
 *
 *  - GET  /session-notify         returns the watch list;
 *  - POST /session-notify         watches or unwatches one session;
 *  - POST /session-notify/test    shows one sample card (install verification);
 *  - GET  /session-notify/events  pushes each committed watch list (SSE);
 *  - 'session/event' with a durable `turn/end` is the only trigger: the turn is
 *    closed in the log, so the assistant output is complete before the card
 *    shows. Nothing polls an agent.
 *
 * The watch list lives in one JSON file under the DSH home, so it survives
 * restarts and window reloads. Windows renders the card through popup.ps1 in
 * this package; other platforms keep the durable watch list and skip the card.
 *
 * @module dsh-session-notify
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'dsh-session-notify'

/** Same-origin route the browser half talks to. */
const ROUTE = '/session-notify'
/** Server-Sent Events route that pushes watch-list changes to every window. */
const EVENTS_ROUTE = '/session-notify/events'
/** Route that shows one sample card with the caller's language. */
const TEST_ROUTE = '/session-notify/test'
/** Route the card itself calls when it is clicked, to open its conversation. */
const OPEN_ROUTE = '/session-notify/open'
/** Route other plugins call to watch or unwatch one session programmatically. */
const WATCH_ROUTE = '/session-notify/watch'
/** Route the page uses to report the DSH theme the card must match. */
const THEME_ROUTE = '/session-notify/theme'
/** Route that reads and writes the defaults a new watch starts with. */
const SETTINGS_ROUTE = '/session-notify/settings'
/** Route that changes one existing watch's reminder mode. */
const MODE_ROUTE = '/session-notify/mode'
/** SSE heartbeat interval; keeps idle proxies and sockets alive. */
const SSE_HEARTBEAT_MS = 20_000
/** Watch-file format version. */
const FILE_VERSION = 1
/** Request-body ceiling for the browser routes. */
const MAX_BODY_BYTES = 32 * 1024
/** Longest session id accepted (session ids are UUIDs, far shorter). */
const MAX_SESSION_ID_LENGTH = 200
/** Longest cached session title. */
const MAX_TITLE_LENGTH = 120
/** Default lifetime of one card, in milliseconds. */
const DEFAULT_DURATION_MS = 8000
/** Shortest accepted card lifetime; below this the card would flash. */
const MIN_DURATION_MS = 1200
/** Longest accepted card lifetime. */
const MAX_DURATION_MS = 60_000
/** Two triggers closer than this are one notification. */
const NOTIFY_COOLDOWN_MS = 800
/** Whether the card stays until a click instead of closing itself. */
const DEFAULT_STICKY = false

/**
 * Visible copy the Host must own: the card is an OS window, drawn outside the
 * Web page, so the Client locale service cannot translate it. The Client sends
 * its current language with each watch and the Host picks the matching words.
 */
const COPY = {
  zh: {
    body: '此对话已结束',
    done: '已完成',
    aborted: '已中断',
    blocked: '已结束',
    error: '出错',
    hint: '点击关闭',
    openHint: '点击打开对话',
    sampleTitle: '会话提醒预览',
  },
  en: {
    body: 'This conversation has finished',
    done: 'Done',
    aborted: 'Stopped',
    blocked: 'Done',
    error: 'Failed',
    hint: 'Click to dismiss',
    openHint: 'Click to open this conversation',
    sampleTitle: 'Notification preview',
  },
}

/** One warning sink that reports each distinct failure once. */
function createLogger() {
  const seen = new Set()
  return (message, error) => {
    const key = error === undefined ? message : message + ': ' + (error?.code ?? error?.message ?? String(error))
    if (seen.has(key)) return
    seen.add(key)
    if (error !== undefined) console.warn('[session-notify] ' + message, error)
    else console.warn('[session-notify] ' + message)
  }
}

/** Copy for one language tag, falling back to English. */
function copyFor(locale) {
  if (typeof locale !== 'string') return COPY.zh
  return locale.toLowerCase().startsWith('en') ? COPY.en : COPY.zh
}

/** A bounded, trimmed title. */
function normalizeTitle(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_TITLE_LENGTH)
}

/** A bounded language tag. */
function normalizeLocale(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 32)
}

/** A non-negative integer timestamp, or 0 when the value is unusable. */
function toTimestamp(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

/** Reminder modes: one card per watch, or one per finished turn until handled. */
const MODES = ['once', 'always']
/** What a new watch starts with when nothing says otherwise. */
const DEFAULT_SETTINGS = { defaultWatch: false, defaultMode: 'once' }

/** `'always'` or `'once'` for a value the API or the settings supplied. */
function normalizeMode(value) {
  return value === 'always' ? 'always' : 'once'
}

/**
 * The mode a stored record means. A record written before modes existed has no
 * field and keeps the every-turn behaviour it was created with, so the missing
 * field reads as `always`; the next write then stores that explicitly.
 */
function storedMode(value) {
  return value === 'once' ? 'once' : 'always'
}

/** Validate one stored watch entry; a missing mode is the old `once`. */
function normalizeEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const since = toTimestamp(value.since)
  return {
    title: normalizeTitle(value.title),
    locale: normalizeLocale(value.locale),
    mode: storedMode(value.mode),
    since,
    lastNotifiedAt: toTimestamp(value.lastNotifiedAt),
    count: toTimestamp(value.count),
  }
}

/** Copy and validate the stored watch map, dropping anything unexpected. */
function normalizeWatched(raw) {
  const watched = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return watched
  for (const [sessionId, value] of Object.entries(raw)) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    if (sessionId.length > MAX_SESSION_ID_LENGTH) continue
    const entry = normalizeEntry(value)
    if (entry !== null) watched[sessionId] = entry
  }
  return watched
}

/** Copy and validate the stored defaults. */
function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return settings
  settings.defaultWatch = raw.defaultWatch === true
  settings.defaultMode = normalizeMode(raw.defaultMode)
  return settings
}

/** A frozen, caller-owned copy of the watch map. */
function snapshotWatched(watched) {
  const copy = {}
  for (const [sessionId, value] of Object.entries(watched)) {
    copy[sessionId] = {
      title: value.title,
      locale: value.locale,
      mode: value.mode,
      since: value.since,
      lastNotifiedAt: value.lastNotifiedAt,
      count: value.count,
    }
  }
  return copy
}

/** Answer one JSON response with no-store caching. */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Read a bounded UTF-8 request body. */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Refuse a cross-site caller that a browser marks with an Origin header. */
function isAcceptableOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (origin === 'null') return false
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/** Validate the shared session id of one mutation payload. */
function readSessionId(payload) {
  const raw = payload?.sessionId
  if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, error: 'sessionId must be a non-empty string' }
  const sessionId = raw.trim()
  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    return { ok: false, error: 'sessionId must be at most ' + MAX_SESSION_ID_LENGTH + ' characters' }
  }
  return { ok: true, sessionId }
}

/**
 * One durable watch map backed by a single JSON file.
 * Reads are served from memory after the first load; writes are serialized and
 * published atomically (temporary file, then rename).
 */
function createStore(file, log) {
  let watched = {}
  let settings = { ...DEFAULT_SETTINGS }
  let loaded = null
  let writeChain = Promise.resolve()
  const listeners = new Set()

  function emit(frame) {
    const snapshot = snapshotWatched(watched)
    for (const listener of listeners) {
      try {
        listener(snapshot, frame)
      } catch (error) {
        log('a watch listener failed', error)
      }
    }
  }

  function load() {
    if (loaded !== null) return loaded
    loaded = (async () => {
      try {
        const text = await readFile(file, 'utf8')
        const parsed = JSON.parse(text)
        watched = normalizeWatched(parsed?.watched)
        settings = normalizeSettings(parsed?.settings)
      } catch (error) {
        if (error?.code !== 'ENOENT') log('could not read ' + file, error)
      }
    })()
    return loaded
  }

  function persist() {
    const body = JSON.stringify({ version: FILE_VERSION, updatedAt: Date.now(), watched, settings }, null, 2)
    writeChain = writeChain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp'
        await writeFile(temporary, body, 'utf8')
        await rename(temporary, file)
      })
      .catch((error) => {
        log('could not write ' + file, error)
      })
    return writeChain
  }

  return {
    load,
    snapshot: () => snapshotWatched(watched),
    /** The live entry for one session, after {@link load}. */
    entryOf: (sessionId) => watched[sessionId],
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Create or refresh one watch without disturbing its counters. */
    async watch(sessionId, patch = {}) {
      await load()
      const title = normalizeTitle(patch.title)
      const locale = normalizeLocale(patch.locale)
      const requested = patch.mode === undefined ? undefined : normalizeMode(patch.mode)
      const previous = watched[sessionId]
      if (previous === undefined) {
        watched[sessionId] = {
          title,
          locale,
          mode: requested ?? settings.defaultMode,
          since: Date.now(),
          lastNotifiedAt: 0,
          count: 0,
        }
        await persist()
        emit({ kind: 'watch', sessionId })
        return snapshotWatched(watched)
      }
      if (title !== '' && title !== previous.title) previous.title = title
      if (locale !== '' && locale !== previous.locale) previous.locale = locale
      if (requested !== undefined && requested !== previous.mode) {
        previous.mode = requested
        await persist()
        emit({ kind: 'mode', sessionId, mode: previous.mode })
      }
      return snapshotWatched(watched)
    },
    /** The defaults new watches start with. */
    settings: () => ({ ...settings }),
    /** Replace the defaults; only the two known keys move. */
    async updateSettings(patch) {
      await load()
      const next = { ...settings }
      if (patch.defaultWatch !== undefined) next.defaultWatch = patch.defaultWatch === true
      if (patch.defaultMode !== undefined) next.defaultMode = normalizeMode(patch.defaultMode)
      if (next.defaultWatch === settings.defaultWatch && next.defaultMode === settings.defaultMode) {
        return { ...settings }
      }
      settings = next
      await persist()
      return { ...settings }
    },
    /** Change one existing watch's mode; null when that session is not watched. */
    async setMode(sessionId, mode) {
      await load()
      const entry = watched[sessionId]
      if (entry === undefined) return null
      const next = normalizeMode(mode)
      if (entry.mode !== next) {
        entry.mode = next
        await persist()
        emit({ kind: 'mode', sessionId, mode: next })
      }
      return entry.mode
    },
    /** Remove one watch. */
    async unwatch(sessionId) {
      await load()
      if (watched[sessionId] === undefined) return snapshotWatched(watched)
      delete watched[sessionId]
      await persist()
      emit({ kind: 'unwatch', sessionId })
      return snapshotWatched(watched)
    },
    /** Record that one card was shown for a finished turn. */
    async markNotified(sessionId, at = Date.now()) {
      await load()
      const entry = watched[sessionId]
      if (entry === undefined) return snapshotWatched(watched)
      entry.lastNotifiedAt = at
      entry.count += 1
      await persist()
      emit({ kind: 'notified', sessionId, at })
      return snapshotWatched(watched)
    },
  }
}

/**
 * The card launcher: one popup.ps1 per finished turn.
 * The script owns its own look, geometry, dismissal, and click; this half only
 * passes text, status, lifetime, and the URL the card posts to when clicked.
 */
function createCards(options, log, spawnImpl = spawn) {
  const script = fileURLToPath(new URL('./popup.ps1', import.meta.url))
  const supported = process.platform === 'win32'

  function powershellPath() {
    if (typeof options.powershell === 'string' && options.powershell.length > 0) return options.powershell
    const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return existsSync(candidate) ? candidate : 'powershell.exe'
  }

  return {
    supported,
    get script() {
      return script
    },
    /** Show one card; returns false when the platform cannot draw it. */
    show(card) {
      if (!supported) return false
      if (!existsSync(script)) {
        log('popup.ps1 is missing next to index.js: ' + script)
        return false
      }
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', script,
        '-Title', card.title,
        '-Body', card.body,
        '-Meta', card.meta,
        '-Accent', card.accent,
        '-DurationMs', String(card.durationMs),
      ]
      if (card.sticky) args.push('-Sticky')
      // The page's own theme beats the Windows one: DSH can be dark while the
      // OS is light. Without a report the script keeps reading the registry.
      if (card.theme === 'dark' || card.theme === 'light') args.push('-Theme', card.theme)
      // Clicking the card closes it and asks this Host to open the session.
      // Without a target the card still closes, so a demo run stays harmless.
      if (typeof card.openUrl === 'string' && card.openUrl.length > 0
        && typeof card.sessionId === 'string' && card.sessionId.length > 0) {
        args.push('-OpenUrl', card.openUrl, '-OpenSession', card.sessionId)
      }
      try {
        // Not detached: on Windows DETACHED_PROCESS gives PowerShell no console
        // and it exits before the script runs. The card is a short-lived child
        // that only has to outlive this call.
        const child = spawnImpl(powershellPath(), args, { stdio: 'ignore', windowsHide: true })
        child.on('error', (error) => log('could not start the notification card', error))
        child.unref()
        return true
      } catch (error) {
        log('could not start the notification card', error)
        return false
      }
    },
  }
}

/** Read and bound the row's config. */
function readOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const requested = Number(source.durationMs)
  const durationMs = Number.isFinite(requested)
    ? Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(requested)))
    : DEFAULT_DURATION_MS
  return {
    enabled: source.enabled !== false,
    durationMs,
    sticky: source.sticky === true ? true : DEFAULT_STICKY,
    powershell: typeof source.powershell === 'string' ? source.powershell : undefined,
  }
}

/** Local wall-clock time without a leading zero, e.g. "8:47" or "18:47". */
function clockText(at) {
  try {
    return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch {
    const date = new Date(at)
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  }
}

/** Card status, copy, and accent for one durable turn end. */
function describeTurnEnd(locale, reason) {
  const copy = copyFor(locale)
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
  const status = copy[kind] ?? copy.done
  return { copy, status, accent: kind === 'error' ? 'error' : kind === 'completed' ? 'done' : 'warn' }
}

/**
 * Server-Sent Events hub: pushes each committed watch map to every open window,
 * and forwards a card click to the windows as a `navigate` frame.
 */
function createEventHub(store, log) {
  const clients = new Set()
  let closed = false
  let unsubscribe = null

  function broadcast(name, payload) {
    let delivered = 0
    for (const client of clients) {
      try {
        client.write('event: ' + name + '\ndata: ' + JSON.stringify(payload) + '\n\n')
        delivered += 1
      } catch {
        clients.delete(client)
      }
    }
    return delivered
  }

  unsubscribe = store.subscribe((watched, frame) => {
    if (closed) return
    broadcast('watched', { ok: true, watched, frame })
  })

  function attach(request, response) {
    if (closed) {
      sendJson(response, 503, { ok: false, error: 'event stream is shutting down' })
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      return
    }
    if (!isAcceptableOrigin(request)) {
      sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
      return
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write('retry: 3000\n\n')

    let heartbeat = null
    let detached = false
    const cleanup = () => {
      if (detached) return
      detached = true
      if (heartbeat !== null) clearInterval(heartbeat)
      clients.delete(response)
    }
    request.on('close', cleanup)
    response.on('close', cleanup)
    heartbeat = setInterval(() => {
      try {
        response.write(': ping\n\n')
      } catch {
        cleanup()
      }
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()

    void store.load().then(() => {
      if (detached) return
      clients.add(response)
      try {
        response.write('event: watched\ndata: ' + JSON.stringify({ ok: true, watched: store.snapshot() }) + '\n\n')
      } catch {
        cleanup()
      }
    }, (error) => {
      log('could not start the event stream', error)
      cleanup()
      try {
        response.end()
      } catch {
        /* the socket is already gone */
      }
    })
  }

  return {
    attach,
    /** Ask every open window to open one conversation; returns how many were told. */
    navigate(sessionId) {
      if (closed) return 0
      return broadcast('navigate', { ok: true, sessionId })
    },
    close() {
      if (closed) return
      closed = true
      if (unsubscribe !== null) unsubscribe()
      for (const client of clients) {
        try {
          client.end()
        } catch {
          /* the client disconnected first */
        }
      }
      clients.clear()
    },
  }
}

/** The browser-facing JSON route: GET the watch list, POST one mutation. */
function createRouteHandler(store, log) {
  return async function handleSessionNotify(request, response) {
    try {
      if (!isAcceptableOrigin(request)) {
        sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      if (request.method === 'GET') {
        await store.load()
        sendJson(response, 200, { ok: true, watched: store.snapshot() })
        return
      }
      if (request.method === 'POST') {
        let payload
        try {
          payload = JSON.parse(await readBody(request, MAX_BODY_BYTES))
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error.message === 'request body is too large' ? error.message : 'invalid JSON body' })
          return
        }
        const session = readSessionId(payload)
        if (!session.ok) {
          sendJson(response, 400, { ok: false, error: session.error })
          return
        }
        const action = payload?.action ?? 'watch'
        if (action === 'watch') {
          const watched = await store.watch(session.sessionId, {
            title: payload?.title,
            locale: payload?.locale,
            mode: payload?.mode,
          })
          sendJson(response, 200, { ok: true, watched, watching: watched[session.sessionId] !== undefined })
          return
        }
        if (action === 'unwatch') {
          const watched = await store.unwatch(session.sessionId)
          sendJson(response, 200, { ok: true, watched, watching: false })
          return
        }
        sendJson(response, 400, { ok: false, error: 'unknown action "' + String(action) + '"' })
        return
      }
      response.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
    } catch (error) {
      log('request failed', error)
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' })
      } catch {
        response.destroy()
      }
    }
  }
}

/**
 * The card's click route: the clicked card posts the session it stands for, and
 * every open window is told to open it. Clicking the card *is* handling the
 * reminder, so the watch it belongs to is retired here in both modes.
 * Unauthenticated but same-origin-checked like the rest of this plugin, and
 * reachable only from this machine.
 */
function createOpenHandler(events, store, log) {
  return async function handleSessionNotifyOpen(request, response) {
    try {
      if (!isAcceptableOrigin(request)) {
        sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(request, MAX_BODY_BYTES))
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message === 'request body is too large' ? error.message : 'invalid JSON body' })
        return
      }
      const session = readSessionId(payload)
      if (!session.ok) {
        sendJson(response, 400, { ok: false, error: session.error })
        return
      }
      const delivered = events.navigate(session.sessionId)
      await store.unwatch(session.sessionId)
      sendJson(response, 200, { ok: true, sessionId: session.sessionId, delivered })
    } catch (error) {
      log('could not open a conversation from a card', error)
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' })
      } catch {
        response.destroy()
      }
    }
  }
}

/**
 * The page reporting which DSH theme the card must match.
 *
 * Rule 5 of the theme agreement: a window drawn outside the page must be told
 * the theme explicitly, because DSH can be dark while Windows is light. The
 * value lives in memory only; `auto` stays the fallback for the case where no
 * page ever reports.
 */
function createThemeHandler(onTheme, log) {
  return async function handleSessionNotifyTheme(request, response) {
    try {
      if (!isAcceptableOrigin(request)) {
        sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(request, MAX_BODY_BYTES))
      } catch {
        sendJson(response, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      const theme = payload?.theme
      if (theme !== 'dark' && theme !== 'light') {
        sendJson(response, 400, { ok: false, error: 'theme must be "dark" or "light"' })
        return
      }
      onTheme(theme)
      sendJson(response, 200, { ok: true, theme })
    } catch (error) {
      log('could not record the page theme', error)
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' })
      } catch {
        response.destroy()
      }
    }
  }
}

/**
 * The programmatic watch route other plugins call.
 *
 * Contract: `POST { sessionId, on: boolean }` → `200 { ok, sessionId, watching }`.
 * It writes through the same store functions the sidebar menu uses, so there is
 * one writer, one durable file, and one SSE stream. Repeating the same request
 * changes nothing and publishes nothing. An id this Host has no live session
 * for answers `200 { ok, watching: false, reason: 'unknown-session' }` instead
 * of writing a watch that could never fire.
 */
function createWatchHandler(store, log, isKnownSession) {
  return async function handleSessionNotifyWatch(request, response) {
    try {
      if (!isAcceptableOrigin(request)) {
        sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(request, MAX_BODY_BYTES))
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message === 'request body is too large' ? error.message : 'invalid JSON body' })
        return
      }
      const session = readSessionId(payload)
      if (!session.ok) {
        sendJson(response, 400, { ok: false, error: session.error })
        return
      }
      if (typeof payload?.on !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'on must be a boolean' })
        return
      }
      // Optional on purpose: a caller may name the mode it wants, otherwise the
      // stored default decides, so the earlier two-field contract still holds.
      if (payload.mode !== undefined && !MODES.includes(payload.mode)) {
        sendJson(response, 400, { ok: false, error: 'mode must be one of ' + MODES.join(', ') })
        return
      }
      if (!isKnownSession(session.sessionId)) {
        sendJson(response, 200, { ok: true, sessionId: session.sessionId, watching: false, reason: 'unknown-session' })
        return
      }
      if (payload.on) await store.watch(session.sessionId, { mode: payload.mode })
      else await store.unwatch(session.sessionId)
      const watching = store.entryOf(session.sessionId) !== undefined
      sendJson(response, 200, { ok: true, sessionId: session.sessionId, watching })
    } catch (error) {
      log('could not change a watch for another plugin', error)
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' })
      } catch {
        response.destroy()
      }
    }
  }
}

/** One settings answer; the flat keys are the canonical contract. */
function settingsPayload(settings) {
  return {
    ok: true,
    settings: { defaultWatch: settings.defaultWatch, defaultMode: settings.defaultMode },
    defaultWatch: settings.defaultWatch,
    defaultMode: settings.defaultMode,
  }
}

/**
 * The defaults other plugins read and write: what a watch starts as, whether a
 * merged panel should watch by itself, and which mode that watch gets.
 */
function createSettingsHandler(store, log) {
  return async function handleSessionNotifySettings(request, response) {
    try {
      if (!isAcceptableOrigin(request)) {
        sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      if (request.method === 'GET') {
        await store.load()
        sendJson(response, 200, settingsPayload(store.settings()))
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(request, MAX_BODY_BYTES))
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message === 'request body is too large' ? error.message : 'invalid JSON body' })
        return
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        sendJson(response, 400, { ok: false, error: 'body must be a JSON object' })
        return
      }
      const keys = Object.keys(payload)
      const unknown = keys.find((key) => key !== 'defaultWatch' && key !== 'defaultMode')
      if (unknown !== undefined) {
        sendJson(response, 400, { ok: false, error: 'unknown key "' + unknown + '"' })
        return
      }
      if (keys.length === 0) {
        sendJson(response, 400, { ok: false, error: 'nothing to change' })
        return
      }
      if (payload.defaultWatch !== undefined && typeof payload.defaultWatch !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'defaultWatch must be a boolean' })
        return
      }
      if (payload.defaultMode !== undefined && !MODES.includes(payload.defaultMode)) {
        sendJson(response, 400, { ok: false, error: 'defaultMode must be one of ' + MODES.join(', ') })
        return
      }
      const settings = await store.updateSettings({
        defaultWatch: payload.defaultWatch,
        defaultMode: payload.defaultMode,
      })
      sendJson(response, 200, settingsPayload(settings))
    } catch (error) {
      log('could not change the watch defaults', error)
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' })
      } catch {
        response.destroy()
      }
    }
  }
}

/**
 * Change one existing watch's mode. An unwatched session is answered, never
 * watched implicitly: the caller decides whether it wants a watch at all.
 */
function createModeHandler(store, log) {
  return async function handleSessionNotifyMode(request, response) {
    try {
      if (!isAcceptableOrigin(request)) {
        sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(request, MAX_BODY_BYTES))
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message === 'request body is too large' ? error.message : 'invalid JSON body' })
        return
      }
      const session = readSessionId(payload)
      if (!session.ok) {
        sendJson(response, 400, { ok: false, error: session.error })
        return
      }
      if (!MODES.includes(payload?.mode)) {
        sendJson(response, 400, { ok: false, error: 'mode must be one of ' + MODES.join(', ') })
        return
      }
      const mode = await store.setMode(session.sessionId, payload.mode)
      if (mode === null) {
        sendJson(response, 200, { ok: true, sessionId: session.sessionId, watching: false, mode: null })
        return
      }
      sendJson(response, 200, { ok: true, sessionId: session.sessionId, watching: true, mode })
    } catch (error) {
      log('could not change a watch mode', error)
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' })
      } catch {
        response.destroy()
      }
    }
  }
}

/**
 * The web origin the card posts back to, or '' when this composition serves no
 * page. Read at card time so a changed port is picked up.
 */
function openBaseUrl(ctx) {  try {
    const webApp = ctx.get('webApp')
    const url = typeof webApp?.getAdvertisedUrl === 'function' ? webApp.getAdvertisedUrl() : undefined
    if (typeof url === 'string' && url.length > 0) return url.replace(/\/+$/, '')
  } catch {
    /* no page in this composition */
  }
  return ''
}

/** The install-verification route: show one sample card in the caller's language. */
function createTestHandler(options, cards, log, resolveOpenUrl, resolveTheme) {
  return async function handleSessionNotifyTest(request, response) {
    try {
      if (!isAcceptableOrigin(request)) {
        sendJson(response, 403, { ok: false, error: 'cross-origin request refused' })
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      let payload = {}
      try {
        const body = await readBody(request, MAX_BODY_BYTES)
        payload = body.trim() === '' ? {} : JSON.parse(body)
      } catch {
        payload = {}
      }
      const copy = copyFor(payload?.locale)
      const sessionId = typeof payload?.sessionId === 'string'
        ? payload.sessionId.trim().slice(0, MAX_SESSION_ID_LENGTH)
        : ''
      const openUrl = sessionId === '' ? '' : resolveOpenUrl()
      const shown = cards.show({
        title: normalizeTitle(payload?.title) || copy.sampleTitle,
        body: copy.body,
        meta: clockText(Date.now()) + ' · ' + (openUrl === '' ? copy.hint : copy.openHint),
        accent: 'done',
        durationMs: options.durationMs,
        sticky: options.sticky,
        openUrl,
        sessionId,
        theme: resolveTheme(),
      })
      sendJson(response, 200, { ok: true, shown, body: copy.body })
    } catch (error) {
      log('sample card failed', error)
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' })
      } catch {
        response.destroy()
      }
    }
  }
}

/**
 * Register the durable watch file, its browser routes, and the turn trigger.
 * @param ctx - Host context.
 * @param config - Optional row config: enabled, durationMs, sticky, powershell.
 * @param seams - Optional process seams; `spawn` replaces node:child_process
 *   spawn so a test can observe the launched card without drawing one.
 */
export function apply(ctx, config, seams = {}) {
  const options = readOptions(config)
  const log = createLogger()
  const homePath = ctx.get('dshHomePath')
  const file = typeof homePath === 'function'
    ? homePath('session-notify.json')
    : join(homedir(), '.dsh', 'session-notify.json')
  const store = createStore(file, log)
  const events = createEventHub(store, log)
  const cards = createCards(options, log, typeof seams?.spawn === 'function' ? seams.spawn : undefined)
  /** Where a clicked card posts; empty when this composition serves no page. */
  const resolveOpenUrl = () => {
    const base = openBaseUrl(ctx)
    return base === '' ? '' : base + OPEN_ROUTE
  }

  // The DSH theme the page reported for this run ('dark' | 'light'), or '' until
  // a page reports one; popup.ps1 then falls back to the Windows theme.
  let webTheme = ''
  const resolveTheme = () => webTheme

  ctx.effect(() => () => events.close(), 'session-notify: event stream')

  /** Whether this Host currently has a live session for that id. */
  const isKnownSession = (sessionId) => {
    let sessions
    try {
      sessions = ctx.get('sessions')
    } catch {
      return true
    }
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return true
    try {
      return sessions.get(sessionId) !== undefined
    } catch {
      return true
    }
  }

  // The only trigger. A durable turn close means the assistant output for that
  // turn is complete, so the card never appears mid-stream.
  ctx.effect(() => ctx.on('session/event', async (session, event) => {
    if (!options.enabled) return
    if (event?.type !== 'turn/end') return
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    try {
      await store.load()
      const entry = store.entryOf(sessionId)
      if (entry === undefined) return
      const now = Date.now()
      if (now - entry.lastNotifiedAt < NOTIFY_COOLDOWN_MS) return
      const described = describeTurnEnd(entry.locale, event.data?.reason)
      await store.markNotified(sessionId, now)
      const openUrl = resolveOpenUrl()
      cards.show({
        title: entry.title || sessionId.slice(0, 8),
        body: described.copy.body,
        meta: described.status + ' · ' + clockText(now) + ' · '
          + (openUrl === '' ? described.copy.hint : described.copy.openHint),
        accent: described.accent,
        durationMs: options.durationMs,
        sticky: options.sticky,
        openUrl,
        sessionId,
        theme: resolveTheme(),
      })
      // `once` means one card per watch: showing it is the end of that watch.
      // `always` keeps the watch until the person handles it (open or turn off).
      if (entry.mode !== 'always') await store.unwatch(sessionId)
    } catch (error) {
      log('could not notify a finished turn', error)
    }
  }), 'session-notify: finished turns')

  // The browser and desktop compositions mount a web server; other surfaces
  // still keep the durable watch list and the turn trigger.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const removeWatches = scope.webServer.register({ kind: 'exact', path: ROUTE, handler: createRouteHandler(store, log) })
      const removeEvents = scope.webServer.register({ kind: 'exact', path: EVENTS_ROUTE, handler: events.attach })
      const removeTest = scope.webServer.register({ kind: 'exact', path: TEST_ROUTE, handler: createTestHandler(options, cards, log, resolveOpenUrl, resolveTheme) })
      const removeOpen = scope.webServer.register({ kind: 'exact', path: OPEN_ROUTE, handler: createOpenHandler(events, store, log) })
      const removeWatch = scope.webServer.register({ kind: 'exact', path: WATCH_ROUTE, handler: createWatchHandler(store, log, isKnownSession) })
      const removeTheme = scope.webServer.register({ kind: 'exact', path: THEME_ROUTE, handler: createThemeHandler((theme) => { webTheme = theme }, log) })
      const removeSettings = scope.webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler: createSettingsHandler(store, log) })
      const removeMode = scope.webServer.register({ kind: 'exact', path: MODE_ROUTE, handler: createModeHandler(store, log) })
      return () => {
        removeMode()
        removeSettings()
        removeTheme()
        removeWatch()
        removeOpen()
        removeTest()
        removeEvents()
        removeWatches()
      }
    }, 'session-notify: browser routes')
  })
}
