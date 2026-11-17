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
