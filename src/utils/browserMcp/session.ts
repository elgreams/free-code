import type { ChildProcess } from 'node:child_process'
import { CdpClient, type CdpEvent } from './cdp.js'
import { launchChrome } from './chrome.js'
import { SNAPSHOT_FN } from './snapshot.js'
import { logForDebugging } from '../debug.js'

const BUFFER_LIMIT = 200

type ConsoleEntry = { level: string; text: string }
type NetworkEntry = {
  method: string
  url: string
  status?: number
  failed?: string
}

type Tab = { targetId: string; sessionId: string }

/**
 * Owns the launched Chrome and its CDP connection, and turns high-level tool
 * calls into CDP commands. One instance per MCP server process; Chrome is
 * launched lazily on the first tool call so server startup stays instant.
 */
export class BrowserSession {
  private proc: ChildProcess | undefined
  private cdp: CdpClient | undefined
  private starting: Promise<void> | undefined
  private readonly tabs: Tab[] = []
  private activeTargetId = ''
  private readonly console = new Map<string, ConsoleEntry[]>()
  private readonly network = new Map<string, NetworkEntry[]>()
  // requestId → buffer key, so responseReceived/loadingFailed can update the
  // entry created at requestWillBeSent time.
  private readonly reqIndex = new Map<string, NetworkEntry>()

  async ensureStarted(): Promise<void> {
    if (this.cdp) {
      return
    }
    if (!this.starting) {
      this.starting = this.start()
    }
    await this.starting
  }

  private async start(): Promise<void> {
    const { proc, browserWSEndpoint } = await launchChrome()
    this.proc = proc
    const cdp = new CdpClient()
    await cdp.connect(browserWSEndpoint)
    this.cdp = cdp
    cdp.onEvent(ev => this.onEvent(ev))

    await cdp.send('Target.setDiscoverTargets', { discover: true })
    const { targetInfos } = (await cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>
    }
    const page = targetInfos.find(
      t => t.type === 'page' && !t.url.startsWith('devtools://'),
    )
    const targetId = page
      ? page.targetId
      : ((await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
          targetId: string
        }).targetId
    await this.attach(targetId)
    this.activeTargetId = targetId
  }

  private async attach(targetId: string): Promise<string> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const { sessionId } = (await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId: string }
    this.console.set(sessionId, [])
    this.network.set(sessionId, [])
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Log.enable', {}, sessionId)
    this.tabs.push({ targetId, sessionId })
    return sessionId
  }

  private get session(): string {
    const tab = this.tabs.find(t => t.targetId === this.activeTargetId)
    if (!tab) {
      throw new Error('no active browser tab')
    }
    return tab.sessionId
  }

  private push<T>(map: Map<string, T[]>, key: string, item: T): void {
    const arr = map.get(key) ?? []
    arr.push(item)
    if (arr.length > BUFFER_LIMIT) {
      arr.shift()
    }
    map.set(key, arr)
  }

  private onEvent(ev: CdpEvent): void {
    const sid = ev.sessionId
    if (!sid) {
      return
    }
    switch (ev.method) {
      case 'Runtime.consoleAPICalled': {
        const p = ev.params as {
          type: string
          args: Array<{ value?: unknown; description?: string }>
        }
        const text = p.args
          .map(a => (a.value !== undefined ? String(a.value) : a.description ?? ''))
          .join(' ')
        this.push(this.console, sid, { level: p.type, text })
        break
      }
      case 'Runtime.exceptionThrown': {
        const p = ev.params as {
          exceptionDetails?: { exception?: { description?: string }; text?: string }
        }
        const text =
          p.exceptionDetails?.exception?.description ??
          p.exceptionDetails?.text ??
          'uncaught exception'
        this.push(this.console, sid, { level: 'error', text })
        break
      }
      case 'Log.entryAdded': {
        const p = ev.params as { entry: { level: string; text: string } }
        this.push(this.console, sid, {
          level: p.entry.level,
          text: p.entry.text,
        })
        break
      }
      case 'Network.requestWillBeSent': {
        const p = ev.params as {
          requestId: string
          request: { url: string; method: string }
        }
        const entry: NetworkEntry = {
          method: p.request.method,
          url: p.request.url,
        }
        this.reqIndex.set(p.requestId, entry)
        this.push(this.network, sid, entry)
        break
      }
      case 'Network.responseReceived': {
        const p = ev.params as {
          requestId: string
          response: { status: number }
        }
        const entry = this.reqIndex.get(p.requestId)
        if (entry) {
          entry.status = p.response.status
        }
        break
      }
      case 'Network.loadingFailed': {
        const p = ev.params as { requestId: string; errorText: string }
        const entry = this.reqIndex.get(p.requestId)
        if (entry) {
          entry.failed = p.errorText
        }
        break
      }
    }
  }

  private async evalRaw(
    expression: string,
  ): Promise<{ value?: unknown; error?: string }> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const res = (await cdp.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      this.session,
    )) as {
      result?: { value?: unknown }
      exceptionDetails?: { exception?: { description?: string }; text?: string }
    }
    if (res.exceptionDetails) {
      return {
        error:
          res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          'evaluation error',
      }
    }
    return { value: res.result?.value }
  }

  // ---- tool operations -------------------------------------------------

  async navigate(url: string): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const sid = this.session
    const loaded = new Promise<void>(resolve => {
      const off = cdp.onEvent(ev => {
        if (ev.sessionId === sid && ev.method === 'Page.loadEventFired') {
          off()
          resolve()
        }
      })
      // Don't hang forever on pages that never fire load (streaming, etc.).
      setTimeout(() => {
        off()
        resolve()
      }, 30_000)
    })
    const res = (await cdp.send('Page.navigate', { url }, sid)) as {
      errorText?: string
    }
    if (res.errorText) {
      throw new Error(`navigation failed: ${res.errorText}`)
    }
    await loaded
    // Brief settle for client-rendered content after the load event.
    await new Promise(r => setTimeout(r, 400))
  }

  async snapshot(): Promise<string> {
    const { value, error } = await this.evalRaw(SNAPSHOT_FN)
    if (error) {
      throw new Error(error)
    }
    return String(value ?? '')
  }

  /** Resolve a ref to its center viewport coordinates, scrolling it into view. */
  private async refPoint(
    ref: string,
  ): Promise<{ x: number; y: number } | { error: string }> {
    const expr = `(() => {
      const el = window.__brefMap && window.__brefMap[${JSON.stringify(ref)}];
      if (!el) return { __err: 'ref ${ref} not found — take a fresh browser_snapshot' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return { __err: 'element for ${ref} is not visible' };
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`
    const { value, error } = await this.evalRaw(expr)
    if (error) {
      return { error }
    }
    const v = value as { x?: number; y?: number; __err?: string }
    if (v?.__err) {
      return { error: v.__err }
    }
    if (typeof v?.x !== 'number' || typeof v?.y !== 'number') {
      return { error: `could not locate ${ref}` }
    }
    return { x: v.x, y: v.y }
  }

  async click(ref: string, doubleClick = false): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const pt = await this.refPoint(ref)
    if ('error' in pt) {
      throw new Error(pt.error)
    }
    const sid = this.session
    const base = { x: pt.x, y: pt.y, button: 'left', buttons: 1 }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 }, sid)
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', ...base, clickCount: doubleClick ? 2 : 1 },
      sid,
    )
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', ...base, clickCount: doubleClick ? 2 : 1 },
      sid,
    )
    await new Promise(r => setTimeout(r, 200))
  }

  async type(ref: string, text: string, submit = false): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    // Focus + clear the field first so typing replaces existing content.
    const focus = await this.evalRaw(`(() => {
      const el = window.__brefMap && window.__brefMap[${JSON.stringify(ref)}];
      if (!el) return { __err: 'ref ${ref} not found — take a fresh browser_snapshot' };
      el.focus();
      if ('value' in el) el.value = '';
      return { ok: true };
    })()`)
    if (focus.error) {
      throw new Error(focus.error)
    }
    const v = focus.value as { __err?: string }
    if (v?.__err) {
      throw new Error(v.__err)
    }
    const sid = this.session
    await cdp.send('Input.insertText', { text }, sid)
    if (submit) {
      await this.pressKeyOn(sid, 'Enter')
    }
  }

  private async pressKeyOn(sid: string, key: string): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const special: Record<
      string,
      { code: string; vk: number; text?: string }
    > = {
      Enter: { code: 'Enter', vk: 13, text: '\r' },
      Tab: { code: 'Tab', vk: 9 },
      Escape: { code: 'Escape', vk: 27 },
      Backspace: { code: 'Backspace', vk: 8 },
      ArrowDown: { code: 'ArrowDown', vk: 40 },
      ArrowUp: { code: 'ArrowUp', vk: 38 },
      ArrowLeft: { code: 'ArrowLeft', vk: 37 },
      ArrowRight: { code: 'ArrowRight', vk: 39 },
    }
    const s = special[key]
    const down: Record<string, unknown> = s
      ? { type: 'keyDown', key, code: s.code, windowsVirtualKeyCode: s.vk, text: s.text }
      : { type: 'keyDown', key, text: key }
    const up: Record<string, unknown> = s
      ? { type: 'keyUp', key, code: s.code, windowsVirtualKeyCode: s.vk }
      : { type: 'keyUp', key }
    await cdp.send('Input.dispatchKeyEvent', down, sid)
    await cdp.send('Input.dispatchKeyEvent', up, sid)
  }

  async pressKey(key: string): Promise<void> {
    await this.pressKeyOn(this.session, key)
  }

  async evaluate(fn: string): Promise<unknown> {
    const { value, error } = await this.evalRaw(`(${fn})()`)
    if (error) {
      throw new Error(error)
    }
    return value
  }

  async screenshot(fullPage = false): Promise<string> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const res = (await cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: fullPage },
      this.session,
    )) as { data: string }
    return res.data
  }

  getConsole(): ConsoleEntry[] {
    return this.console.get(this.session) ?? []
  }

  getNetwork(): NetworkEntry[] {
    return this.network.get(this.session) ?? []
  }

  async wait(seconds: number): Promise<void> {
    await new Promise(r => setTimeout(r, Math.min(seconds, 30) * 1000))
  }

  // ---- tab management --------------------------------------------------

  async listTabs(): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const { targetInfos } = (await cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>
    }
    return this.tabs.map((t, index) => {
      const info = targetInfos.find(i => i.targetId === t.targetId)
      return {
        index,
        url: info?.url ?? '',
        title: info?.title ?? '',
        active: t.targetId === this.activeTargetId,
      }
    })
  }

  async newTab(url?: string): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const { targetId } = (await cdp.send('Target.createTarget', {
      url: url ?? 'about:blank',
    })) as { targetId: string }
    await this.attach(targetId)
    this.activeTargetId = targetId
  }

  selectTab(index: number): void {
    const tab = this.tabs[index]
    if (!tab) {
      throw new Error(`no tab at index ${index}`)
    }
    this.activeTargetId = tab.targetId
  }

  async closeTab(index: number): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const tab = this.tabs[index]
    if (!tab) {
      throw new Error(`no tab at index ${index}`)
    }
    await cdp.send('Target.closeTarget', { targetId: tab.targetId })
    this.tabs.splice(index, 1)
    this.console.delete(tab.sessionId)
    this.network.delete(tab.sessionId)
    if (this.activeTargetId === tab.targetId) {
      this.activeTargetId = this.tabs[0]?.targetId ?? ''
    }
  }

  shutdown(): void {
    try {
      this.cdp?.close()
    } catch {
      // ignore
    }
    try {
      this.proc?.kill()
    } catch (err) {
      logForDebugging(`[browser] failed to kill chrome: ${err}`)
    }
  }
}
