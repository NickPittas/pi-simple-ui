const SERVER_NAME = /^[A-Za-z0-9_-]{1,128}$/
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/** Main-owned secret sink. The application wires this to its existing secure credential storage; this module creates no sidecar file. */
export interface McpSecretBackend {
  set(server: string, key: string, value: string): void
  delete(server: string, key: string): boolean
  clearServer(server: string): boolean
}

function assertName(server: string, key?: string): void {
  if (!SERVER_NAME.test(server) || UNSAFE_NAMES.has(server)) throw new TypeError('MCP server name is invalid.')
  if (key !== undefined && (!SECRET_KEY.test(key) || UNSAFE_NAMES.has(key))) throw new TypeError('MCP secret key is invalid.')
}

/** Main-process-only, write-only facade. Secret values are never returned to IPC callers. */
export class McpSecretsStore {
  private readonly backend: McpSecretBackend

  constructor(backend: McpSecretBackend) {
    this.backend = backend
  }

  set(server: string, key: string, value: string): void {
    assertName(server, key)
    if (typeof value !== 'string' || value.length === 0 || value.length > 65_536) {
      throw new TypeError('MCP secret value is invalid.')
    }
    this.backend.set(server, key, value)
  }

  delete(server: string, key: string): boolean {
    assertName(server, key)
    return this.backend.delete(server, key)
  }

  clearServer(server: string): boolean {
    assertName(server)
    return this.backend.clearServer(server)
  }
}
