import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readEnabledModelPatterns, resolveScopedModels } from './scoped-models.ts'

const m = (provider: string, id: string, name = id) => ({ provider, id, name })
const catalogue = [m('zai', 'glm-5.3'), m('zai', 'glm-5.3-flash'), m('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5'), m('openai-codex', 'gpt-6-luna'), m('openai-codex-account-2', 'gpt-6-luna')]

describe('resolveScopedModels', () => {
  it('resolves exact provider/id references in pattern order', () => {
    expect(resolveScopedModels(['openai-codex/gpt-6-luna', 'zai/glm-5.3'], catalogue).map((x) => `${x.provider}/${x.id}`)).toEqual(['openai-codex/gpt-6-luna', 'zai/glm-5.3'])
  })
  it('is case-insensitive and ignores a thinking suffix', () => {
    expect(resolveScopedModels(['ZAI/GLM-5.3:high'], catalogue)).toEqual([m('zai', 'glm-5.3')])
  })
  it('expands globs and de-duplicates', () => {
    expect(resolveScopedModels(['zai/*', 'zai/glm-5.3'], catalogue).map((x) => x.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
  })
  it('matches a bare id across providers', () => {
    expect(resolveScopedModels(['gpt-6-luna'], catalogue)).toHaveLength(2)
  })
  it('drops patterns that match nothing and returns [] for no patterns', () => {
    expect(resolveScopedModels(['nope/x'], catalogue)).toEqual([])
    expect(resolveScopedModels([], catalogue)).toEqual([])
  })
})

describe('readEnabledModelPatterns', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scoped-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('reads string entries only', async () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ enabledModels: ['a/b', 3, '', 'c/d'] }))
    expect(await readEnabledModelPatterns(file)).toEqual(['a/b', 'c/d'])
  })
  it('returns [] for a missing, malformed or key-less file', async () => {
    expect(await readEnabledModelPatterns(join(dir, 'missing.json'))).toEqual([])
    const bad = join(dir, 'bad.json'); writeFileSync(bad, '{oops')
    expect(await readEnabledModelPatterns(bad)).toEqual([])
    const none = join(dir, 'none.json'); writeFileSync(none, '{}')
    expect(await readEnabledModelPatterns(none)).toEqual([])
  })
})
