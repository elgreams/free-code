import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { logForDebugging } from '../debug.js'

// Persistent profile so logins/cookies stick across sessions. A dedicated dir
// (not the user's default Chrome profile) means we launch an independent
// instance that never collides with their everyday browser.
export function getBrowserProfileDir(): string {
  return join(getClaudeConfigHomeDir(), 'browser-mcp', 'profile')
}

/**
 * Candidate Chrome/Chromium executables per platform. First existing one wins.
 * `CLAUDE_BROWSER_EXECUTABLE` overrides everything (used in CI / on boxes
 * without Google Chrome, pointed at a Chromium binary).
 */
function chromeCandidates(): string[] {
  const override = process.env.CLAUDE_BROWSER_EXECUTABLE
  if (override) {
    return [override]
  }
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files'
    const pf86 =
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    const local = process.env['LOCALAPPDATA'] ?? ''
    return [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ].filter(Boolean) as string[]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  // Linux: PATH-resolved names first, then common absolute paths.
  return [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]
}

function resolveChromePath(): string | undefined {
  for (const cand of chromeCandidates()) {
    // Bare names (no path separator) are resolved by the OS via PATH at spawn;
    // accept them optimistically. Absolute paths must exist on disk.
    if (!cand.includes('/') && !cand.includes('\\')) {
      return cand
    }
    if (existsSync(cand)) {
      return cand
    }
  }
  return undefined
}

export type LaunchedChrome = {
  proc: ChildProcess
  port: number
  browserWSEndpoint: string
}

async function readDevToolsPort(
  profileDir: string,
  timeoutMs: number,
): Promise<number> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const start = Date.now()
  // Poll the DevToolsActivePort file Chrome writes once the debug server is up.
  // (Date.now() is available here — chrome.ts only runs in the live MCP
  // subprocess, never inside a replayable Workflow script.)
  while (Date.now() - start < timeoutMs) {
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, 'utf8').trim()
      const port = Number.parseInt(raw.split('\n')[0] ?? '', 10)
      if (Number.isFinite(port) && port > 0) {
        return port
      }
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(
    'Chrome did not expose a DevTools port in time (DevToolsActivePort missing)',
  )
}

/**
 * Launch the user's installed Chrome with a TCP remote-debugging port and a
 * persistent profile, then resolve its browser-level WebSocket endpoint.
 *
 * Uses `--remote-debugging-port` (TCP), NOT `--remote-debugging-pipe`: the pipe
 * relies on inherited fds 3/4 which Bun-on-Windows does not pass to children.
 * A plain port spawn has no extra fds, so it works under Bun on every OS.
 */
export async function launchChrome(): Promise<LaunchedChrome> {
  const exe = resolveChromePath()
  if (!exe) {
    throw new Error(
      'No Chrome/Chromium found. Install Google Chrome, or set ' +
        'CLAUDE_BROWSER_EXECUTABLE to a Chromium binary.',
    )
  }
  const profile = getBrowserProfileDir()
  mkdirSync(profile, { recursive: true })
  // A stale port file from a crashed prior run would be read as a live port.
  rmSync(join(profile, 'DevToolsActivePort'), { force: true })

  const args = [
    '--remote-debugging-port=0', // 0 → Chrome picks a free port, written to DevToolsActivePort
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,AcceptCHFrame',
    '--homepage=about:blank',
    // Extra space-separated args (e.g. --no-sandbox in containers/CI).
    ...(process.env.CLAUDE_BROWSER_EXTRA_ARGS
      ? process.env.CLAUDE_BROWSER_EXTRA_ARGS.split(' ').filter(Boolean)
      : []),
    'about:blank',
  ]
  logForDebugging(`[browser] launching ${exe}`)
  const proc = spawn(exe, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Detach so a hung Chrome can't keep our process group alive; we still hold
    // the handle and kill it explicitly on shutdown.
    detached: false,
  })
  proc.on('error', err =>
    logForDebugging(`[browser] chrome spawn error: ${err}`),
  )

  const port = await readDevToolsPort(profile, 30_000)
  const version = (await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json()) as { webSocketDebuggerUrl?: string }
  const browserWSEndpoint = version.webSocketDebuggerUrl
  if (!browserWSEndpoint) {
    throw new Error('Chrome did not report a browser WebSocket endpoint')
  }
  logForDebugging(`[browser] chrome debug port ${port}`)
  return { proc, port, browserWSEndpoint }
}
