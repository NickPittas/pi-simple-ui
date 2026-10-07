import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatInputService } from './input-service.ts'
import { RuntimeOperations } from './runtime-operations.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const MiB = 1024 * 1024
const scope = { ownerId: 'o', generation: 1 }
const caller = { windowId: 1, webContentsId: 1, frameUrl: 'app://x' } as any

let root: string
let outside: string
let session: any
let svc: ChatInputService

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'input-svc-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'input-svc-out-')))
  session = {
    isStreaming: false,
    prompt: vi.fn(async () => {}),
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
  }
  const runtime = { scope, runtimeId: 'r1', workspaceRoot: root, agentDir: root, trustDecision: 'trusted', host: { session } } as any
  svc = new ChatInputService(new RuntimeOperations(() => runtime))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const put = (name: string, bytes: Buffer, dir = root) => {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}
const image = (path: string) => ({ type: 'image' as const, path })
const text = (path: string) => ({ type: 'text' as const, path })
const send = (attachments?: any[]) => svc.prompt(caller, scope, { text: 'hi', attachments })
const rejects = async (attachments: any[], message: string) => {
  await expect(send(attachments)).rejects.toThrow(message)
  expect(session.prompt).not.toHaveBeenCalled()
}
const sentImages = () => session.prompt.mock.calls[0][1].images

describe('image mime sniffing', () => {
  it.each([
    ['png', PNG, 'image/png'],
    ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]), 'image/jpeg'],
    ['gif87', Buffer.from('GIF87a....'), 'image/gif'],
    ['gif89', Buffer.from('GIF89a....'), 'image/gif'],
    ['webp', Buffer.from('RIFF\0\0\0\0WEBPxx'), 'image/webp'],
  ])('detects %s', async (_n, bytes, mimeType) => {
    const p = put('x.dat', bytes)
    await expect(send([image(p)])).resolves.toEqual({ accepted: true })
    expect(sentImages()).toEqual([{ type: 'image', data: bytes.toString('base64'), mimeType }])
  })

  it('content wins over extension', async () => {
    await send([image(put('x.jpg', PNG))])
    expect(sentImages()[0].mimeType).toBe('image/png')
  })

  it.each([
    ['truncated png', PNG.subarray(0, 7)],
    ['wav', Buffer.from('RIFF\0\0\0\0WAVExx')],
    ['plain text', Buffer.from('hello world')],
  ])('rejects %s', async (_n, bytes) => {
    await rejects([image(put('x.png', bytes))], 'An image attachment has an unsupported or invalid format.')
  })
})

describe('prompt options', () => {
  it('omits images when there are no attachments', async () => {
    await expect(send()).resolves.toEqual({ accepted: true })
    const options = session.prompt.mock.calls[0][1]
    expect(session.prompt.mock.calls[0][0]).toBe('hi')
    expect('images' in options).toBe(false)
    expect(options.source).toBe('interactive')
  })

  it('keeps image order', async () => {
    const a = put('a.png', PNG)
    const b = put('b.gif', Buffer.from('GIF89a..'))
    await send([image(a), image(b)])
    expect(sentImages().map((i: any) => i.mimeType)).toEqual(['image/png', 'image/gif'])
  })
})

describe('path and file-system errors', () => {
  const MISSING = 'An attachment is missing or outside the active workspace.'
  it('rejects relative path', async () => rejects([image('x.png')], MISSING))
  it('rejects path outside root', async () => rejects([image(put('o.png', PNG, outside))], MISSING))
  it('rejects .. segment', async () => {
    put('a.png', PNG)
    await rejects([image(`${root}/sub/../a.png`)], MISSING)
  })
  it('rejects missing file', async () => rejects([image(join(root, 'nope.png'))], MISSING))
  it('rejects symlink escaping root', async () => {
    const target = put('o.png', PNG, outside)
    const link = join(root, 'link.png')
    symlinkSync(target, link)
    await rejects([image(link)], MISSING)
  })
  it('rejects a directory', async () => {
    const dir = join(root, 'dir')
    mkdirSync(dir)
    await rejects([image(dir)], 'An attachment could not be read.')
  })
})

describe('size limits', () => {
  const big = (name: string, size: number) => put(name, Buffer.concat([PNG, Buffer.alloc(size - PNG.length)]))
  const LIMIT = 'An attachment exceeds the size limit.'

  it('rejects a single file over 8 MiB', async () => rejects([image(big('a.png', 8 * MiB + 1))], LIMIT))
  it('rejects the third 6 MiB image', async () => {
    await rejects([image(big('a.png', 6 * MiB)), image(big('b.png', 6 * MiB)), image(big('c.png', 6 * MiB))], LIMIT)
  })
  it('accepts two 6 MiB images', async () => {
    await send([image(big('a.png', 6 * MiB)), image(big('b.png', 6 * MiB))])
    expect(sentImages()).toHaveLength(2)
  })
})

describe('text attachments', () => {
  it('rejects a valid .txt as unsupported by the SDK', async () => {
    await rejects([text(put('a.txt', Buffer.from('hello')))], 'Text-file attachments are not supported by the current Pi SDK.')
  })
  it('rejects unsupported extension', async () => {
    await rejects([text(put('a.bin', Buffer.from('hello')))], 'A text attachment must use a supported text-file extension.')
  })
  it('rejects invalid UTF-8', async () => {
    await rejects([text(put('a.txt', Buffer.from([0xff, 0xfe, 0xfd])))], 'A text attachment is not valid UTF-8.')
  })
})
