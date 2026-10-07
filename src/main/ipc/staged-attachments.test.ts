import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pruneStagedAttachments, stagedAttachmentDir } from './staged-attachments.ts'

describe('pruneStagedAttachments', () => {
  const original = process.env.TMPDIR
  const base = tmpdir()
  let root: string
  beforeEach(() => { root = mkdtempSync(join(base, 'prune-')); process.env.TMPDIR = root })
  afterEach(() => { if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original; rmSync(root, { recursive: true, force: true }) })

  it('returns 0 when the directory does not exist', async () => {
    expect(await pruneStagedAttachments()).toBe(0)
  })

  it('removes only files older than the max age', async () => {
    const dir = stagedAttachmentDir()
    mkdirSync(dir, { recursive: true })
    const oldFile = join(dir, 'old.png'), newFile = join(dir, 'new.png')
    writeFileSync(oldFile, 'x'); writeFileSync(newFile, 'y')
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
    utimesSync(oldFile, twoDaysAgo, twoDaysAgo)
    expect(await pruneStagedAttachments()).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(newFile)).toBe(true)
  })
})
