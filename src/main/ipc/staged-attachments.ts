import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const STAGED_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function stagedAttachmentDir(): string {
  return join(tmpdir(), 'pi-gui-attachments')
}

export async function ensureStagedAttachmentDir(): Promise<string> {
  const dir = stagedAttachmentDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Removes staged attachment files older than maxAgeMs. Best effort; never throws. */
export async function pruneStagedAttachments(maxAgeMs = STAGED_ATTACHMENT_MAX_AGE_MS, now = Date.now()): Promise<number> {
  const dir = stagedAttachmentDir()
  let removed = 0
  let names: string[]
  try { names = await readdir(dir) } catch { return 0 }
  for (const name of names) {
    const path = join(dir, name)
    try {
      if (now - (await stat(path)).mtimeMs > maxAgeMs) { await rm(path, { force: true }); removed++ }
    } catch { /* ignore */ }
  }
  return removed
}
