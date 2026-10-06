import { safeStorage, type SafeStorage } from 'electron'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { McpSecretBackend } from './secrets.ts'

const MAX_STORE_BYTES = 4 * 1024 * 1024
const SERVER_NAME = /^[A-Za-z0-9_-]{1,128}$/
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

type SecretDocument = Record<string, Record<string, string>>

function validSecretDocument(value: unknown): value is SecretDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([server, entries]) =>
    SERVER_NAME.test(server)
      && !UNSAFE_NAMES.has(server)
      && entries !== null
      && typeof entries === 'object'
      && !Array.isArray(entries)
      && Object.entries(entries).every(([key, secret]) =>
        SECRET_KEY.test(key)
          && !UNSAFE_NAMES.has(key)
          && typeof secret === 'string'
          && secret.length > 0
          && secret.length <= 65_536))
}

/** Persists MCP app secrets only as Electron safeStorage ciphertext in app-owned data. */
export class ElectronMcpSecretBackend implements McpSecretBackend {
  private readonly path: string
  private readonly storage: SafeStorage

  constructor(path: string, storage: SafeStorage = safeStorage) {
    if (!isAbsolute(path) || path.includes('\0')) throw new TypeError('MCP secret store path must be absolute.')
    this.path = resolve(path)
    this.storage = storage
  }

  set(server: string, key: string, value: string): void {
    const document = this.read()
    const entries = document[server] ?? Object.create(null) as Record<string, string>
    entries[key] = value
    document[server] = entries
    this.write(document)
  }

  delete(server: string, key: string): boolean {
    const document = this.read()
    const entries = document[server]
    if (!entries || !Object.hasOwn(entries, key)) return false
    delete entries[key]
    if (Object.keys(entries).length === 0) delete document[server]
    this.write(document)
    return true
  }

  clearServer(server: string): boolean {
    const document = this.read()
    if (!Object.hasOwn(document, server)) return false
    delete document[server]
    this.write(document)
    return true
  }

  private read(): SecretDocument {
    this.assertSecureStorage()
    if (!existsSync(this.path)) return Object.create(null) as SecretDocument
    const stats = lstatSync(this.path)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STORE_BYTES) {
      throw new Error('The encrypted MCP secret store is invalid.')
    }
    let envelope: unknown
    try {
      envelope = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
    } catch {
      throw new Error('The encrypted MCP secret store cannot be read.')
    }
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).length !== 2
      || !Object.hasOwn(envelope, 'version') || !Object.hasOwn(envelope, 'ciphertext')
      || Reflect.get(envelope, 'version') !== 1
      || typeof Reflect.get(envelope, 'ciphertext') !== 'string') {
      throw new Error('The encrypted MCP secret store has an unsupported format.')
    }
    const encoded = Reflect.get(envelope, 'ciphertext') as string
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('The encrypted MCP secret store is invalid.')
    }
    let value: unknown
    try {
      value = JSON.parse(this.storage.decryptString(Buffer.from(encoded, 'base64'))) as unknown
    } catch {
      throw new Error('The encrypted MCP secret store cannot be decrypted.')
    }
    if (!validSecretDocument(value)) throw new Error('The decrypted MCP secret store is invalid.')
    return value
  }

  private write(document: SecretDocument): void {
    this.assertSecureStorage()
    const ciphertext = this.storage.encryptString(JSON.stringify(document)).toString('base64')
    const encoded = JSON.stringify({ version: 1, ciphertext })
    if (Buffer.byteLength(encoded, 'utf8') > MAX_STORE_BYTES) throw new Error('The MCP secret store exceeds its size limit.')
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, encoded, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, this.path)
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(temporary)) rmSync(temporary, { force: true })
    }
  }

  private assertSecureStorage(): void {
    if (!this.storage.isEncryptionAvailable()
      || process.platform === 'linux'
        && !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.storage.getSelectedStorageBackend())) {
      throw new Error('OS-backed encryption is unavailable for MCP secrets.')
    }
  }
}
