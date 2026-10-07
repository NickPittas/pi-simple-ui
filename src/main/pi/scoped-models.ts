import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { NativeModelChoice } from '../../shared/native-pi.ts'

/** Pi's own settings file; enabledModels is its model-cycling allowlist. */
export function piSettingsPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'settings.json')
}

export async function readEnabledModelPatterns(path = piSettingsPath()): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as { enabledModels?: unknown }).enabledModels : undefined
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
  } catch { return [] }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * Resolves enabledModels patterns against the catalogue, preserving pattern order.
 * Supports exact "provider/id", bare id, and * ? globs. A trailing ":level" thinking suffix is ignored.
 */
export function resolveScopedModels(patterns: readonly string[], catalogue: readonly NativeModelChoice[]): NativeModelChoice[] {
  const out: NativeModelChoice[] = []
  const seen = new Set<string>()
  const add = (model: NativeModelChoice) => { const key = `${model.provider}/${model.id}`; if (!seen.has(key)) { seen.add(key); out.push(model) } }
  for (const raw of patterns) {
    const pattern = raw.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i, '')
    const exact = catalogue.find((m) => `${m.provider}/${m.id}`.toLowerCase() === pattern.toLowerCase())
    if (exact) { add(exact); continue }
    const re = globToRegExp(pattern)
    const matches = catalogue.filter((m) => re.test(`${m.provider}/${m.id}`) || re.test(m.id) || re.test(m.name))
    if (matches.length) matches.forEach(add)
  }
  return out
}
