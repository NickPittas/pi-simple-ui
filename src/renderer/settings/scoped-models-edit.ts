export type CatalogueModel = { provider: string; id: string; name: string }
export type ParsedEnabled = { ok: true; enabled: string[]; present: boolean } | { ok: false; error: string }

export const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`

/** Reads enabledModels (strings only) from settings.json text. Never throws. */
export function parseEnabledModels(text: string): ParsedEnabled {
  let root: unknown
  try { root = text.trim() ? JSON.parse(text) : {} } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Invalid JSON' } }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return { ok: false, error: 'settings.json must contain a JSON object' }
  const value = (root as Record<string, unknown>).enabledModels
  if (value === undefined) return { ok: true, enabled: [], present: false }
  if (!Array.isArray(value)) return { ok: false, error: 'enabledModels must be an array' }
  return { ok: true, enabled: value.filter((entry): entry is string => typeof entry === 'string'), present: true }
}

/** Returns text with only enabledModels replaced; all other keys are kept. */
export function serializeEnabledModels(text: string, enabled: readonly string[]): { ok: true; text: string } | { ok: false; error: string } {
  let root: Record<string, unknown>
  try {
    const parsed: unknown = text.trim() ? JSON.parse(text) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, error: 'settings.json must contain a JSON object' }
    root = parsed as Record<string, unknown>
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Invalid JSON' } }
  return { ok: true, text: `${JSON.stringify({ ...root, enabledModels: [...enabled] }, null, 2)}\n` }
}

export const toggleModel = (enabled: readonly string[], key: string): string[] =>
  enabled.includes(key) ? enabled.filter((entry) => entry !== key) : [...enabled, key]

/** Moves entry at index by delta; out-of-bounds moves return the list unchanged. */
export function moveEntry(enabled: readonly string[], index: number, delta: -1 | 1): string[] {
  const to = index + delta
  if (index < 0 || index >= enabled.length || to < 0 || to >= enabled.length) return [...enabled]
  const next = [...enabled]
  ;[next[index], next[to]] = [next[to]!, next[index]!]
  return next
}

/** Selects (or clears) every model of a provider, keeping existing order and appending new ones. */
export function setProvider(enabled: readonly string[], models: readonly CatalogueModel[], provider: string, on: boolean): string[] {
  const keys = models.filter((model) => model.provider === provider).map(modelKey)
  if (!on) return enabled.filter((entry) => !keys.includes(entry))
  return [...enabled, ...keys.filter((key) => !enabled.includes(key))]
}

export const unknownEntries = (enabled: readonly string[], models: readonly CatalogueModel[]): string[] => {
  const known = new Set(models.map(modelKey))
  return enabled.filter((entry) => !known.has(entry))
}
