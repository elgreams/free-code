import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'

export const BROWSER_MCP_SERVER_NAME = 'browser'

// Persistent on/off toggle (default off). Set via /browser.
export function isBrowserEnabled(): boolean {
  return getGlobalConfig().browserEnabled === true
}

export function setBrowserEnabled(enabled: boolean): void {
  saveGlobalConfig(cfg => ({ ...cfg, browserEnabled: enabled }))
}

// Dev runtime = running via the `bun` executable (process.execPath is bun). A
// compiled standalone exe has its own execPath, so we spawn it with just the
// flag; dev spawns the bun runtime with the script path + flag.
function isDevBunRuntime(): boolean {
  const exe = process.execPath.toLowerCase()
  return exe.endsWith('bun') || exe.endsWith('bun.exe')
}

/**
 * MCP server config that spawns this binary's `--browser-mcp` entrypoint, which
 * runs the custom CDP-based browser server (drives installed Chrome; no
 * Node/npx/Playwright). Mirrors the claude-in-chrome built-in registration.
 */
export function getBrowserMcpServerConfig(): Record<
  string,
  ScopedMcpServerConfig
> {
  const args = isDevBunRuntime()
    ? [process.argv[1], '--browser-mcp']
    : ['--browser-mcp']
  return {
    [BROWSER_MCP_SERVER_NAME]: {
      type: 'stdio' as const,
      command: process.execPath,
      args,
      scope: 'dynamic' as const,
    },
  }
}
