/**
 * dsh-session-notify — browser half.
 *
 * Watches chosen conversations and tells the Host to announce their finished
 * turns on the desktop.
 *
 *  - every session row's "…" menu gets "结束时提醒" / "已开启结束时提醒";
 *  - the same menu offers "试弹一次提醒" so the card can be checked on demand;
 *  - a watched session's row shows a small bell in the trailing seat; clicking
 *    the bell turns the watch off.
 *
 * The watch list is durable Host data read and written through the same-origin
 * '/session-notify' JSON route; '/session-notify/events' pushes changes to
 * every open window over Server-Sent Events. The card itself is an OS window
 * drawn by the Host (popup.ps1), so this half only decides what is watched and
 * keeps the stored title in step with the session catalog.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const NS = 'session-notify'
    const ENDPOINT = '/session-notify'
    const EVENTS = '/session-notify/events'
    const TEST_ENDPOINT = '/session-notify/test'
    const THEME_ENDPOINT = '/session-notify/theme'

    /* ------------------------------------------------------------------ *
     * Dictionaries (English is the key-set source of truth)
     * ------------------------------------------------------------------ */

    const EN = {
      'menu.group': 'Session notifications',
      'menu.groupOn': 'Session notifications · on',
      'menu.watch': 'Notify when this session finishes',
      'menu.watching': 'Finish notification is on',
      'menu.preview': 'Show a sample notification',
      'bell.watching': 'Finish notification is on — click to turn it off',
      'error.save': 'Could not change the finish notification',
      'error.preview': 'Could not show the sample notification',
      'toggle.on': 'Notifications for this session turned on',
      'toggle.off': 'Notifications for this session turned off',
      'selftest.title': 'Self-test',
      'selftest.run': 'Run self-test',
      'selftest.running': 'Running…',
      'selftest.sample': 'Show a sample card',
      'selftest.copy': 'Copy result',
      'selftest.copied': 'Copied to the clipboard',
      'selftest.copyFailed': 'Copy failed — the clipboard is not available',
      'selftest.sampleSent': 'The Host was asked for one sample card',
      'selftest.sampleFailed': 'The sample card request failed',
      'selftest.idle': 'Not run',
      'selftest.pass': 'Pass',
      'selftest.fail': 'Fail',
      'selftest.skip': 'Skipped',
      'selftest.summary': '{pass} passed · {fail} failed · {skip} skipped',
      'selftest.colon': ': ',
      'selftest.route': 'Host routes (GET /session-notify)',
      'selftest.events': 'Event stream (/session-notify/events)',
      'selftest.card': 'Sample card (/session-notify/test, pops one card)',
      'selftest.theme': 'Theme endpoint (/session-notify/theme)',
      'selftest.timeout': 'no answer within the 2 s budget',
      'selftest.noAnswer': 'the request could not be made',
      'selftest.http': 'HTTP {status}',
      'selftest.badList': 'the watch list is missing from the answer',
      'selftest.watching': '{count} session(s) watched',
      'selftest.noEventSource': 'EventSource is unavailable in this page',
      'selftest.eventsSilent': 'the stream stayed silent (skipped)',
      'selftest.eventsUnavailable': 'the stream did not open (skipped)',
      'selftest.cardMissing': 'the Host answered but showed no card',
      'selftest.themeExpected400': 'expected 400 for a bad value, got {status}',
    }

    const ZH = {
      'menu.group': '会话提醒设置',
      'menu.groupOn': '会话提醒设置 · 开',
      'menu.watch': '结束时提醒',
      'menu.watching': '已开启结束时提醒',
      'menu.preview': '试弹一次提醒',
      'bell.watching': '已开启结束时提醒，点击关闭',
      'error.save': '结束提醒设置失败',
      'error.preview': '示例提醒没有弹出',
      'toggle.on': '已开启这个会话的结束提醒',
      'toggle.off': '已关闭这个会话的结束提醒',
      'selftest.title': '自检',
      'selftest.run': '运行自检',
      'selftest.running': '运行中…',
      'selftest.sample': '弹一张示例卡',
      'selftest.copy': '复制结果',
      'selftest.copied': '已复制到剪贴板',
      'selftest.copyFailed': '复制失败——当前页面拿不到剪贴板',
      'selftest.sampleSent': '已让宿主弹出一张示例卡',
      'selftest.sampleFailed': '示例卡请求失败',
      'selftest.idle': '未运行',
      'selftest.pass': '通过',
      'selftest.fail': '失败',
      'selftest.skip': '跳过',
      'selftest.summary': '{pass} 通过 · {fail} 失败 · {skip} 跳过',
      'selftest.colon': '：',
      'selftest.route': '后台路由（GET /session-notify）',
      'selftest.events': '事件流（/session-notify/events）',
      'selftest.card': '示例卡（/session-notify/test，会弹一张卡）',
      'selftest.theme': '主题端点（/session-notify/theme）',
      'selftest.timeout': '2 秒内没有响应',
      'selftest.noAnswer': '请求没有发出去',
      'selftest.http': 'HTTP {status}',
      'selftest.badList': '返回里没有 watching 列表',
      'selftest.watching': '关注中 {count} 个会话',
      'selftest.noEventSource': '当前页面没有 EventSource',
      'selftest.eventsSilent': '2 秒内没有收到首帧（跳过）',
      'selftest.eventsUnavailable': '事件流连不上（跳过）',
      'selftest.cardMissing': '宿主应答了但没有弹卡',
      'selftest.themeExpected400': '非法值应返回 400，实际 {status}',
    }

    const LOCALES = { zh: ZH, en: EN, ja: EN, es: EN, fr: EN, de: EN, ru: EN, pt: EN }

    /* ------------------------------------------------------------------ *
     * Styles — theme tokens only
     * ------------------------------------------------------------------ */

    const CSS = [
      '.sn-bellwrap{display:inline-flex;align-items:center;flex:none;margin-left:2px}',
      '.sn-bell{appearance:none;box-sizing:border-box;width:15px;height:15px;padding:0;margin:0;flex:none;',
      'border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-state-business-primary);',
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:opacity .12s ease,background .12s ease}',
      '.sn-bell:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}',
      '.sn-bell:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.sn-bell svg{width:12px;height:12px;display:block}',
      '.sn-st{margin-top:18px;display:flex;flex-direction:column;gap:10px}',
      '.sn-st-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.sn-st-title{margin:0 auto 0 0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.sn-st-btn{appearance:none;box-sizing:border-box;font:inherit;font-size:12px;line-height:18px;height:28px;padding:0 12px;',
      'border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;',
      'display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
      '.sn-st-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.sn-st-btn[data-primary=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.sn-st-btn:disabled{opacity:.55;cursor:default}',
      '.sn-st-btn:disabled:hover{background:transparent}',
      '.sn-st-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.sn-st-sum{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.sn-st-list{display:flex;flex-direction:column;gap:2px}',
      '.sn-st-row{display:flex;align-items:flex-start;gap:10px;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.sn-st-label{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.sn-st-detail{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.sn-st-badge{flex:none;font-size:11px;line-height:16px;padding:2px 8px;border-radius:999px;',
      'border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.sn-st-badge[data-status=pass]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.sn-st-badge[data-status=fail]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.sn-st-badge[data-status=run]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.sn-st-badge[data-status=skip]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
    ].join('\n')

    /* ------------------------------------------------------------------ *
     * Glyphs
     * ------------------------------------------------------------------ */

    /** A bell: outline when idle, filled while it rings for a session. */
    function BellGlyph({ filled = false }) {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 2.1a3.5 3.5 0 0 0-3.5 3.5v2.1L3.6 9.6c-.3.5 0 1.1.6 1.1h7.6c.6 0 .9-.6.6-1.1l-.9-1.9V5.6A3.5 3.5 0 0 0 8 2.1Z',
          fill: filled ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M6.4 12.2a1.7 1.7 0 0 0 3.2 0',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }))
    }

    /* ------------------------------------------------------------------ *
     * One live watch map shared by every slot instance
     * ------------------------------------------------------------------ */

    function normalizeMap(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
      const watched = {}
      for (const [sessionId, value] of Object.entries(raw)) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) continue
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
        watched[sessionId] = {
          title: typeof value.title === 'string' ? value.title : '',
          locale: typeof value.locale === 'string' ? value.locale : '',
          mode: value.mode === 'always' ? 'always' : 'once',
          since: Number(value.since) || 0,
          lastNotifiedAt: Number(value.lastNotifiedAt) || 0,
          count: Number(value.count) || 0,
        }
      }
      return watched
    }

    function createWatchedStore() {
      let state = { ready: false, error: '', watched: {} }
      const listeners = new Set()
      const navigateListeners = new Set()
      let source = null
      let started = false

      function publish() {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            /* one broken subscriber must not stop the rest */
          }
        }
      }

      function patch(next) {
        state = { ...state, ...next }
        publish()
      }

      function applyServer(watched) {
        patch({ watched: normalizeMap(watched), ready: true, error: '' })
      }

      async function refresh() {
        try {
          const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' })
          const payload = await response.json()
          if (payload?.ok !== true) throw new Error('host refused the watch list')
          applyServer(payload.watched)
        } catch {
          patch({ error: 'load' })
        }
      }

      async function post(route, body) {
        const response = await fetch(route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = await response.json()
        if (payload?.ok !== true) throw new Error(payload?.error ?? 'host refused the change')
        if (payload.watched !== undefined) applyServer(payload.watched)
        return payload
      }

      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** Hear a card click: the Host asks every window to open one conversation. */
        onNavigate(listener) {
          navigateListeners.add(listener)
          return () => {
            navigateListeners.delete(listener)
          }
        },
        /** Load once and keep the map live for as long as the plugin is loaded. */
        start() {
          if (started) return
          started = true
          void refresh()
          if (typeof EventSource === 'function') {
            source = new EventSource(EVENTS)
            source.addEventListener('watched', (event) => {
              try {
                const payload = JSON.parse(event.data)
                if (payload?.ok === true) applyServer(payload.watched)
              } catch {
                /* a malformed push is ignored; the next one or a focus refresh repairs it */
              }
            })
            // A clicked card asks the Host to open its conversation; every open
            // window hears it and opens the session.
            source.addEventListener('navigate', (event) => {
              let sessionId = ''
              try {
                const payload = JSON.parse(event.data)
                if (payload?.ok === true && typeof payload.sessionId === 'string') sessionId = payload.sessionId
              } catch {
                return
              }
              if (sessionId === '') return
              for (const listener of [...navigateListeners]) {
                try {
                  listener(sessionId)
                } catch {
                  /* one broken listener must not stop the rest */
                }
              }
            })
            source.addEventListener('error', () => {
              void refresh()
            })
          }
          const onVisibility = () => {
            if (document.visibilityState === 'visible') void refresh()
          }
          document.addEventListener('visibilitychange', onVisibility)
          this.stopSync = () => {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        },
        stop() {
          if (!started) return
          started = false
          if (source !== null) {
            source.close()
            source = null
          }
          this.stopSync?.()
          this.stopSync = undefined
        },
        /** Turn one session's finish notification on or off. */
        async toggle(sessionId, { title, locale }) {
          const watching = state.watched[sessionId] !== undefined
          try {
            await post(ENDPOINT, {
              action: watching ? 'unwatch' : 'watch',
              sessionId,
              title,
              locale,
              // The menu promises a card for every finished turn, so it asks for
              // `always`; programmatic callers get the stored default instead.
              mode: 'always',
            })
            return { ok: true, watching: !watching }
          } catch (error) {
            return { ok: false, watching, error }
          }
        },
        /** Refresh the stored title/language of an existing watch, quietly. */
        async restate(sessionId, { title, locale }) {
          try {
            await post(ENDPOINT, { action: 'watch', sessionId, title, locale })
          } catch {
            /* the next catalog change retries it */
          }
        },
        /** Tell the Host which DSH theme the card must match; failures stay silent. */
        async reportTheme(theme) {
          try {
            await fetch(THEME_ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ theme }),
            })
          } catch {
            /* the next theme flip reports again */
          }
        },
        /** Ask the Host to show one sample card that still jumps to the session. */
        async preview(title, locale, sessionId) {
          try {
            await post(TEST_ENDPOINT, { title, locale, sessionId })
            return { ok: true }
          } catch (error) {
            return { ok: false, error }
          }
        },
      }
    }

    const watchedStore = createWatchedStore()

    /** Re-render on every watch-map change. */
    function useWatchedState() {
      const [state, setState] = useState(watchedStore.getSnapshot)
      useEffect(() => watchedStore.subscribe(() => setState(watchedStore.getSnapshot())), [])
      return state
    }

    /* ------------------------------------------------------------------ *
     * Session catalog helpers
     * ------------------------------------------------------------------ */

    /** Look a service up without letting a missing one break rendering. */
    function readService(ctx, name) {
      try {
        return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
      } catch {
        return undefined
      }
    }

    /** The browser session catalog's snapshot store, when composed. */
    function sessionCatalog(ctx) {
      const sessions = readService(ctx, 'sessions')
      const list = sessions === undefined || sessions === null ? undefined : sessions.list
      if (list === undefined || list === null) return undefined
      if (typeof list.getSnapshot !== 'function') return undefined
      return list
    }

    function catalogSnapshot(list) {
      let raw
      try {
        raw = list?.getSnapshot?.()
      } catch {
        raw = undefined
      }
      if (raw === null || typeof raw !== 'object') return { ids: [], byId: {} }
      const byId = raw.byId !== null && typeof raw.byId === 'object' ? raw.byId : {}
      return { ids: Array.isArray(raw.ids) ? raw.ids : Object.keys(byId), byId }
    }

    /** The session title, or an empty string. */
    function titleOf(ctx, sessionId) {
      const list = sessionCatalog(ctx)
      if (list === undefined) return ''
      const summary = catalogSnapshot(list).byId[sessionId]
      return summary !== undefined && typeof summary.title === 'string' ? summary.title.trim() : ''
    }

    /** The active Client language, for the OS-level card the Host draws. */
    function activeLanguage(ctx) {
      const locale = readService(ctx, 'locale')
      try {
        const snapshot = locale?.getSnapshot?.()
        return typeof snapshot?.active === 'string' ? snapshot.active : ''
      } catch {
        return ''
      }
    }

    /**
     * The theme this page paints: 'dark' while `body[data-ds-dark-theme]` is
     * present, 'light' otherwise, '' when there is no body to read. Rule 5 of
     * the theme agreement forbids guessing from the OS for that reason.
     */
    function documentTheme() {
      try {
        const body = document.body
        if (body === null || body === undefined) return ''
        return typeof body.hasAttribute === 'function' && body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
      } catch {
        return ''
      }
    }

    /** Subscribe to locale revisions so translated copy re-renders on switch. */
    function useLocaleRevision(locale) {
      const [revision, setRevision] = useState(0)
      useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setRevision((value) => value + 1))
      }, [locale])
      return revision
    }

    /* ------------------------------------------------------------------ *
     * Sidebar bell
     * ------------------------------------------------------------------ */

    /** The resting bell in the trailing seat: only rendered while watched. */
    function SessionNotifyBell({ ctx, sessionId }) {
      const locale = ctx.locale ?? readService(ctx, 'locale')
      useLocaleRevision(locale)
      const t = locale.bind(NS)
      const state = useWatchedState()
      if (sessionId === undefined || state.watched[sessionId] === undefined) return null
      const label = t('bell.watching')
      return h('span', { className: 'sn-bellwrap' }, h('button', {
        type: 'button',
        className: 'sn-bell',
        'aria-pressed': true,
        'aria-label': label,
        title: label,
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          void watchedStore.toggle(sessionId, { title: titleOf(ctx, sessionId), locale: activeLanguage(ctx) })
        },
        onPointerDown: (event) => event.stopPropagation(),
        onDoubleClick: (event) => event.stopPropagation(),
      }, h(BellGlyph, { filled: true })))
    }

    /* ------------------------------------------------------------------ *
     * Session menu contribution
     * ------------------------------------------------------------------ */

    /** The sample-card glyph, drawn at the shared icon size. */
    function DownloadGlyph() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 3.1v6.4M5.2 6.6 8 9.4l2.8-2.8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3.6 11.6v1.1h8.8v-1.1',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }))
    }

    const ICON_BELL = 'session-notify.bell'
    const ICON_BELL_ON = 'session-notify.bell-on'
    const ICON_DOWNLOAD = 'session-notify.download'

    /**
     * One session's notification actions: a single "会话提醒设置" row whose
     * submenu holds the toggle and the sample card. The shared menu owns that
     * submenu, so opening, keyboard movement, and placement are the native ones.
     */
    function sessionNotifyActions(ctx, target) {
      const locale = ctx.locale ?? readService(ctx, 'locale')
      const t = locale.bind(NS)
      const watching = watchedStore.getSnapshot().watched[target.sessionId] !== undefined
      const title = typeof target.displayTitle === 'string' && target.displayTitle.trim() !== ''
        ? target.displayTitle.trim()
        : titleOf(ctx, target.sessionId)
      return [{
        id: 'settings',
        label: watching ? t('menu.groupOn') : t('menu.group'),
        icon: { key: watching ? ICON_BELL_ON : ICON_BELL },
        children: [
          {
            id: 'toggle',
            label: watching ? t('menu.watching') : t('menu.watch'),
            icon: { key: watching ? ICON_BELL_ON : ICON_BELL },
            run: async () => {
              const result = await watchedStore.toggle(target.sessionId, { title, locale: activeLanguage(ctx) })
              const menus = readService(ctx, 'contextMenus')
              if (result.ok) menus?.notify?.(t(result.watching ? 'toggle.on' : 'toggle.off'), true)
              else menus?.notify?.(t('error.save'), false)
            },
          },
          {
            id: 'preview',
            label: t('menu.preview'),
            icon: { key: ICON_DOWNLOAD },
            run: () => {
              void watchedStore.preview(title, activeLanguage(ctx), target.sessionId)
            },
          },
        ],
      }]
    }

    /* ------------------------------------------------------------------ *
     * Self-test section on this plugin's detail page
     * ------------------------------------------------------------------ */

    const PACKAGE_NAME = 'dsh-session-notify'
    const CHECK_TIMEOUT_MS = 2000

    /** One request under the section's budget; never throws. */
    async function probe(path, init, timeoutMs) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(path, Object.assign({}, init, { signal: controller.signal }))
        let json
        try {
          json = await response.json()
        } catch {
          json = undefined
        }
        return { reached: true, status: response.status, json }
      } catch {
        return { reached: false, timedOut: controller.signal.aborted, status: 0 }
      } finally {
        clearTimeout(timer)
      }
    }

    /** The four checks, each bounded by the section's budget. */
    function selfTestChecks(t, locale, timeoutMs) {
      const missed = (result) => (result.timedOut ? t('selftest.timeout') : t('selftest.noAnswer'))
      return [
        {
          id: 'route',
          label: t('selftest.route'),
          run: async () => {
            const result = await probe(ENDPOINT, { headers: { accept: 'application/json' }, cache: 'no-store' }, timeoutMs)
            if (!result.reached) return { ok: false, detail: missed(result) }
            if (result.status !== 200) return { ok: false, detail: t('selftest.http', { status: result.status }) }
            const watched = result.json?.watched
            if (result.json?.ok !== true || watched === null || typeof watched !== 'object') {
              return { ok: false, detail: t('selftest.badList') }
            }
            return { ok: true, detail: t('selftest.watching', { count: Object.keys(watched).length }) }
          },
        },
        {
          id: 'events',
          label: t('selftest.events'),
          run: () => {
            if (typeof EventSource !== 'function') return { skip: true, detail: t('selftest.noEventSource') }
            return new Promise((resolve) => {
              let done = false
              let timer = null
              const source = new EventSource(EVENTS)
              const finish = (value) => {
                if (done) return
                done = true
                if (timer !== null) clearTimeout(timer)
                try {
                  source.close()
                } catch {
                  /* already closed */
                }
                resolve(value)
              }
              timer = setTimeout(() => finish({ skip: true, detail: t('selftest.eventsSilent') }), timeoutMs)
              source.addEventListener('watched', () => finish({ ok: true }))
              source.addEventListener('error', () => finish({ skip: true, detail: t('selftest.eventsUnavailable') }))
            })
          },
        },
        {
          id: 'card',
          label: t('selftest.card'),
          run: async () => {
            const result = await probe(TEST_ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ locale }),
            }, timeoutMs)
            if (!result.reached) return { ok: false, detail: missed(result) }
            if (result.status !== 200) return { ok: false, detail: t('selftest.http', { status: result.status }) }
            if (result.json?.shown !== true) return { ok: false, detail: t('selftest.cardMissing') }
            return { ok: true }
          },
        },
        {
          id: 'theme',
          label: t('selftest.theme'),
          run: async () => {
            // An invalid value must be refused; a 400 proves the route exists and
            // validates, without touching the theme the cards actually use.
            const result = await probe(THEME_ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ theme: '__selftest__' }),
            }, timeoutMs)
            if (!result.reached) return { ok: false, detail: missed(result) }
            if (result.status === 400) return { ok: true }
            return { ok: false, detail: t('selftest.themeExpected400', { status: result.status }) }
          },
        },
      ]
    }

    /** The section: a run button, the summary, the rows, and a Markdown copy. */
    function SelfTestSection({ ctx, subject, timeoutMs }) {
      const locale = ctx.locale ?? readService(ctx, 'locale')
      useLocaleRevision(locale)
      const t = locale.bind(NS)
      const [rows, setRows] = useState([])
      const [running, setRunning] = useState(false)
      const [note, setNote] = useState('')
      const budget = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : CHECK_TIMEOUT_MS
      const language = activeLanguage(ctx) === '' ? 'zh' : activeLanguage(ctx)
      const checks = selfTestChecks(t, language, budget)
      const mine = subject !== null && typeof subject === 'object'
        && (subject.kind === 'bundle' || subject.kind === 'row')
        && subject.pkg !== null && typeof subject.pkg === 'object'
        && subject.pkg.name === PACKAGE_NAME
      if (!mine) return null

      const counts = rows.reduce((acc, row) => {
        if (row.status === 'pass') acc.pass += 1
        else if (row.status === 'skip') acc.skip += 1
        else if (row.status === 'fail') acc.fail += 1
        return acc
      }, { pass: 0, fail: 0, skip: 0 })
      const summary = rows.length === 0
        ? t('selftest.idle')
        : t('selftest.summary', { pass: counts.pass, fail: counts.fail, skip: counts.skip })

      const pending = () => checks.map((check) => ({ id: check.id, label: check.label, status: 'run', detail: '' }))

      const run = async () => {
        if (running) return
        setRunning(true)
        setNote('')
        setRows(pending())
        const settled = []
        for (const check of checks) {
          let outcome
          try {
            outcome = await check.run()
          } catch (error) {
            outcome = { ok: false, detail: String(error?.message ?? error) }
          }
          settled.push({
            id: check.id,
            label: check.label,
            status: outcome.skip === true ? 'skip' : outcome.ok === true ? 'pass' : 'fail',
            detail: typeof outcome.detail === 'string' ? outcome.detail : '',
          })
          setRows(settled.concat(checks.slice(settled.length).map((rest) => ({
            id: rest.id, label: rest.label, status: 'run', detail: '',
          }))))
        }
        setRows(settled)
        setRunning(false)
      }

      const showSample = async () => {
        const result = await probe(TEST_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ locale: language }),
        }, budget)
        setNote(result.reached && result.status === 200 ? t('selftest.sampleSent') : t('selftest.sampleFailed'))
      }

      const statusText = (status) => (status === 'pass' ? t('selftest.pass')
        : status === 'fail' ? t('selftest.fail')
          : status === 'skip' ? t('selftest.skip')
            : status === 'run' ? t('selftest.running') : t('selftest.idle'))

      const markdown = () => rows.map((row) => (row.status === 'pass'
        ? '- [x] ' + row.label + ' — ' + t('selftest.pass')
        : '- [ ] ' + row.label + ' — ' + statusText(row.status)
          + (row.detail === '' ? '' : t('selftest.colon') + row.detail))).join('\n')

      const copy = async () => {
        const text = rows.length === 0 ? t('selftest.idle') : markdown()
        try {
          await navigator.clipboard.writeText(text)
          setNote(t('selftest.copied'))
        } catch {
          setNote(t('selftest.copyFailed'))
        }
      }

      return h('div', { className: 'sn-st', 'data-selftest': PACKAGE_NAME },
        h('div', { className: 'sn-st-head' },
          h('h3', { className: 'sn-st-title' }, t('selftest.title')),
          h('button', {
            type: 'button',
            className: 'sn-st-btn',
            'data-primary': 'true',
            'data-selftest-action': 'run',
            disabled: running,
            onClick: () => {
              void run()
            },
          }, running ? t('selftest.running') : t('selftest.run')),
          h('button', {
            type: 'button',
            className: 'sn-st-btn',
            'data-selftest-action': 'sample',
            disabled: running,
            onClick: () => {
              void showSample()
            },
          }, t('selftest.sample')),
          h('span', { className: 'sn-st-sum', 'data-selftest-summary': summary }, summary),
          h('button', {
            type: 'button',
            className: 'sn-st-btn',
            'data-selftest-action': 'copy',
            disabled: rows.length === 0,
            onClick: () => {
              void copy()
            },
          }, t('selftest.copy'))),
        note === '' ? null : h('p', { className: 'sn-st-sum', 'data-selftest-note': note }, note),
        h('div', { className: 'sn-st-list' }, rows.map((row) => h('div', {
          key: row.id,
          className: 'sn-st-row',
          'data-check': row.id,
          'data-status': row.status,
        },
          h('div', { className: 'sn-st-label' },
            h('div', null, row.label),
            row.detail === '' || row.status === 'run' ? null : h('div', { className: 'sn-st-detail' }, row.detail)),
          h('span', { className: 'sn-st-badge', 'data-status': row.status }, statusText(row.status))))))
    }

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale', 'contextMenus'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-session-notify/SessionNotify.css')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'session-notify: styles')

        ctx.effect(() => ctx.locale.register(NS, LOCALES), 'session-notify: dictionaries')

        ctx.effect(() => {
          watchedStore.start()
          return () => watchedStore.stop()
        }, 'session-notify: watch sync')

        // The card is an OS window, so it cannot read the page's theme: report
        // it now and after every flip of `body[data-ds-dark-theme]`.
        ctx.effect(() => {
          const report = () => {
            const theme = documentTheme()
            if (theme !== '') void watchedStore.reportTheme(theme)
          }
          report()
          const body = document.body
          if (typeof MutationObserver !== 'function' || body === null || typeof body !== 'object') return undefined
          const observer = new MutationObserver(report)
          observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
          return () => observer.disconnect()
        }, 'session-notify: theme report')

        // A clicked card closes itself and asks for its conversation; that is
        // the same navigation the sidebar rows use.
        ctx.effect(() => watchedStore.onNavigate((sessionId) => {
          const workspace = readService(ctx, 'uiWorkspace')
          if (workspace === undefined || workspace === null) return
          if (typeof workspace.openSession !== 'function') return
          try {
            workspace.openSession(sessionId)
          } catch (error) {
            console.warn('[session-notify] could not open ' + sessionId + ':', error)
          }
        }), 'session-notify: open from a card')

        // A generated title arrives after the first turn, so the stored title
        // follows the catalog while the watch exists. The Host keeps it quiet:
        // an unchanged title never rewrites the file or publishes.
        ctx.effect(() => {
          const list = sessionCatalog(ctx)
          if (list === undefined || typeof list.subscribe !== 'function') return undefined
          const sync = () => {
            const { byId } = catalogSnapshot(list)
            const watched = watchedStore.getSnapshot().watched
            const language = activeLanguage(ctx)
            for (const sessionId of Object.keys(watched)) {
              const summary = byId[sessionId]
              const title = summary !== undefined && typeof summary.title === 'string' ? summary.title.trim() : ''
              const entry = watched[sessionId]
              const titleStale = title !== '' && title !== entry.title
              const localeStale = language !== '' && language !== entry.locale
              if (!titleStale && !localeStale) continue
              void watchedStore.restate(sessionId, { title: titleStale ? title : entry.title, locale: language })
            }
          }
          sync()
          return list.subscribe(sync)
        }, 'session-notify: title sync')

        const Bell = (props) => h(SessionNotifyBell, Object.assign({}, props, { ctx }))
        const Section = (props) => h(SelfTestSection, Object.assign({}, props, { ctx }))

        // The self-test lives on this plugin's own detail page and runs only when
        // its button is pressed, so opening a page never fires requests.
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-session-notify.selftest',
          order: 90,
          locale: NS,
        }, Section))

        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing',
          id: 'session-notify',
          order: 90,
          locale: NS,
        }, Bell))

        // Glyphs for the contribution's actions; the shared menu renders them
        // by key and keeps its own sizing.
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: ICON_BELL,
        }, () => h(BellGlyph, {})))

        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: ICON_BELL_ON,
        }, () => h(BellGlyph, { filled: true })))

        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: ICON_DOWNLOAD,
        }, DownloadGlyph))

        // One entry instead of two: the toggle and the sample card live in its
        // submenu, and the shared menu re-resolves whenever the watch map moves.
        ctx.effect(() => ctx.contextMenus.register({
          id: 'session-notify.reminders',
          target: 'session',
          order: 460,
          observe: () => [watchedStore],
          resolve: (target) => sessionNotifyActions(ctx, target),
        }), 'session-notify: session menu')
      },
    }
  },
})
