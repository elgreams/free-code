import type { BrowserSession } from './session.js'

type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type ToolDef = {
  name: string
  description: string
  inputSchema: JsonSchema
}

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export type ToolResult = { content: Content[]; isError?: boolean }

export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: 'browser_navigate',
    description:
      'Navigate the active tab to a URL and return an accessibility snapshot of the loaded page.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Capture an accessibility snapshot of the current page. Each actionable element has a [ref=eN] used by browser_click / browser_type. Prefer this over a screenshot for understanding page structure.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_click',
    description:
      'Click an element identified by its ref from a recent snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref, e.g. e5' },
        doubleClick: { type: 'boolean', description: 'Double-click instead of single' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_type',
    description:
      'Focus a text field (by ref) and type text into it, replacing existing content. Set submit=true to press Enter afterward.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref, e.g. e5' },
        text: { type: 'string', description: 'Text to type' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_press_key',
    description:
      'Press a single key on the active page (e.g. Enter, Tab, Escape, ArrowDown, or a character).',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name or character' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_evaluate',
    description:
      'Evaluate a JavaScript function in the page and return its (JSON-serializable) result. Provide a function expression, e.g. "() => document.title".',
    inputSchema: {
      type: 'object',
      properties: {
        function: { type: 'string', description: 'JS function expression to call' },
      },
      required: ['function'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a PNG screenshot of the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_console_messages',
    description: 'Return console messages and page errors captured on the active tab.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_network_requests',
    description: 'Return network requests captured on the active tab since it loaded.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a number of seconds (max 30), e.g. for content to settle.',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Seconds to wait' } },
      required: ['seconds'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_tabs',
    description:
      'Manage tabs. action: "list" | "new" | "select" | "close". For new, optionally pass url; for select/close pass index.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        index: { type: 'number', description: 'Tab index for select/close' },
        url: { type: 'string', description: 'URL for new tab' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })

export async function dispatchTool(
  session: BrowserSession,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  await session.ensureStarted()
  switch (name) {
    case 'browser_navigate': {
      await session.navigate(String(args.url))
      return text(await session.snapshot())
    }
    case 'browser_snapshot':
      return text(await session.snapshot())
    case 'browser_click': {
      await session.click(String(args.ref), Boolean(args.doubleClick))
      return text(await session.snapshot())
    }
    case 'browser_type': {
      await session.type(String(args.ref), String(args.text), Boolean(args.submit))
      return text(await session.snapshot())
    }
    case 'browser_press_key': {
      await session.pressKey(String(args.key))
      return text(await session.snapshot())
    }
    case 'browser_evaluate': {
      const result = await session.evaluate(String(args.function))
      return text(JSON.stringify(result, null, 2) ?? 'undefined')
    }
    case 'browser_screenshot': {
      const data = await session.screenshot(Boolean(args.fullPage))
      return { content: [{ type: 'image', data, mimeType: 'image/png' }] }
    }
    case 'browser_console_messages': {
      const msgs = session.getConsole()
      if (msgs.length === 0) {
        return text('(no console messages)')
      }
      return text(msgs.map(m => `[${m.level}] ${m.text}`).join('\n'))
    }
    case 'browser_network_requests': {
      const reqs = session.getNetwork()
      if (reqs.length === 0) {
        return text('(no network requests captured)')
      }
      return text(
        reqs
          .map(r => {
            const status = r.failed
              ? `FAILED ${r.failed}`
              : r.status ?? '(pending)'
            return `${r.method} ${r.url} → ${status}`
          })
          .join('\n'),
      )
    }
    case 'browser_wait': {
      await session.wait(Number(args.seconds) || 0)
      return text(`waited ${args.seconds}s`)
    }
    case 'browser_tabs': {
      const action = String(args.action)
      if (action === 'list') {
        const tabs = await session.listTabs()
        return text(
          tabs
            .map(
              t =>
                `${t.active ? '*' : ' '} [${t.index}] ${t.title || '(untitled)'} — ${t.url}`,
            )
            .join('\n') || '(no tabs)',
        )
      }
      if (action === 'new') {
        await session.newTab(args.url ? String(args.url) : undefined)
        return text(await session.snapshot())
      }
      if (action === 'select') {
        session.selectTab(Number(args.index))
        return text(await session.snapshot())
      }
      if (action === 'close') {
        await session.closeTab(Number(args.index))
        return text('tab closed')
      }
      return { content: [{ type: 'text', text: `unknown tab action: ${action}` }], isError: true }
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  }
}
