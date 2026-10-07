import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerNativePiCapabilities } from './native-pi.ts'

const SCOPE_ERROR = 'A native runtime scope is required for native Pi operations.'

let tmp: string
let originalTmpdir: string | undefined
let host: { scope: { processGeneration: number } } | null

function capability() {
  const cap = registerNativePiCapabilities({
    activeHost: () => host as any,
    workspaceSnapshot: vi.fn(),
    openSession: vi.fn(),
  }).find((c) => c.id === 'native.pi.stage-attachment')
  if (!cap) throw new Error('capability missing')
  return cap
}
const ctx = (generation = 3) => ({ scope: { ownerId: 'o', generation } }) as any
const stagedDir = () => join(tmp, 'pi-gui-attachments')

beforeEach(() => {
  originalTmpdir = process.env.TMPDIR
  tmp = mkdtempSync(join(tmpdir(), 'native-pi-test-'))
  process.env.TMPDIR = tmp
  host = { scope: { processGeneration: 3 } }
})

afterEach(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = originalTmpdir
  rmSync(tmp, { recursive: true, force: true })
})

describe('stage-attachment validateRequest', () => {
  const valid = (r: unknown) => capability().validateRequest(r)
  it('accepts valid and empty payloads', () => {
    expect(valid({ name: 'a.png', bytesBase64: 'QUJD' })).toBe(true)
    expect(valid({ name: 'a.png', bytesBase64: '' })).toBe(true)
  })
  it('rejects bad shapes and names', () => {
    expect(valid({ name: 'a', bytesBase64: 'QUJD', extra: 1 })).toBe(false)
    expect(valid({ name: 'a' })).toBe(false)
    expect(valid({ name: '', bytesBase64: 'QUJD' })).toBe(false)
    expect(valid({ name: 'a'.repeat(256), bytesBase64: 'QUJD' })).toBe(false)
  })
  it('rejects bad base64', () => {
    expect(valid({ name: 'a', bytesBase64: 'A'.repeat(10_000_001) })).toBe(false)
    expect(valid({ name: 'a', bytesBase64: 'QQ-_' })).toBe(false)
    expect(valid({ name: 'a', bytesBase64: 'QU JD' })).toBe(false)
    expect(valid({ name: 'a', bytesBase64: '=A' })).toBe(false)
    expect(valid({ name: 'a', bytesBase64: 'A===' })).toBe(false)
  })
  it('currently accepts base64 whose length is not a multiple of 4', () => {
    expect(valid({ name: 'a', bytesBase64: 'abc' })).toBe(false)
  })
})

describe('stage-attachment validateResponse', () => {
  const valid = (r: unknown) => capability().validateResponse(r)
  it('checks path', () => {
    expect(valid({ path: '/x' })).toBe(true)
    expect(valid({ path: '' })).toBe(false)
    expect(valid({})).toBe(false)
    expect(valid({ path: '/x', extra: 1 })).toBe(false)
  })
})

describe('stage-attachment handle', () => {
  const stage = (name: string, bytes = 'ABC') =>
    capability().handle(ctx(), { name, bytesBase64: Buffer.from(bytes).toString('base64') }) as Promise<{ path: string }>

  it('writes decoded bytes with restrictive modes', async () => {
    const { path } = await stage('a.png', 'ABC')
    expect(path).toMatch(/pi-gui-attachments\/[0-9a-f-]{36}-a\.png$/)
    expect(path.startsWith(stagedDir())).toBe(true)
    expect(readFileSync(path).toString()).toBe('ABC')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(stagedDir()).mode & 0o777).toBe(0o700)
  })

  it.each([
    ['../../etc/passwd', '-passwd'],
    ['my file (1).png', '-my_file_1_.png'],
    ['/', '-attachment'],
  ])('sanitises %s', async (name, suffix) => {
    const { path } = await stage(name)
    expect(path.endsWith(suffix)).toBe(true)
  })

  it('keeps the last 120 characters of a long name', async () => {
    const name = 'a'.repeat(180) + 'b'.repeat(120)
    const { path } = await stage(name)
    expect(path.endsWith('-' + 'b'.repeat(120))).toBe(true)
    expect(path.slice(-121)).toBe('-' + 'b'.repeat(120))
  })

  it('rejects without a scope', async () => {
    await expect(capability().handle({ scope: undefined } as any, { name: 'a', bytesBase64: '' })).rejects.toThrow(SCOPE_ERROR)
  })
  it('rejects without an active host', async () => {
    host = null
    await expect(stage('a')).rejects.toThrow(SCOPE_ERROR)
  })
  it('rejects on generation mismatch', async () => {
    await expect(capability().handle(ctx(2), { name: 'a', bytesBase64: '' })).rejects.toThrow(SCOPE_ERROR)
  })
  it('rejects oversize payloads and writes nothing', async () => {
    const bytesBase64 = Buffer.alloc(7_500_003).toString('base64')
    await expect(capability().handle(ctx(), { name: 'a', bytesBase64 })).rejects.toThrow('The attachment is too large.')
    expect(existsSync(stagedDir()) ? readdirSync(stagedDir()) : []).toEqual([])
  })
})
