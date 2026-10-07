import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from './fuzzy.ts'

describe('fuzzyScore', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyScore('GLM', 'zai/glm-5.3')).not.toBeNull()
    expect(fuzzyScore('g5', 'glm-5.3')).not.toBeNull()
  })
  it('returns null when characters are missing or out of order', () => {
    expect(fuzzyScore('xyz', 'glm-5.3')).toBeNull()
    expect(fuzzyScore('mlg', 'glm')).toBeNull()
  })
  it('scores an empty query as 0', () => { expect(fuzzyScore('  ', 'anything')).toBe(0) })
  it('prefers consecutive and word-start matches', () => {
    expect(fuzzyScore('opus', 'claude-opus-5-5')!).toBeGreaterThan(fuzzyScore('opus', 'ollama-pro-usage-s')!)
  })
})

describe('fuzzyFilter', () => {
  const items = ['claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6-luna', 'glm-5.3-flash']
  it('returns all items in order for an empty query', () => { expect(fuzzyFilter(items, '', (x) => [x])).toEqual(items) })
  it('filters and ranks best match first', () => {
    const out = fuzzyFilter(items, 'opus', (x) => [x])
    expect(out).toEqual(['claude-opus-5-5'])
    expect(fuzzyFilter(items, 'lun', (x) => [x])[0]).toBe('gpt-6-luna')
  })
  it('matches on any provided field', () => {
    const models = [{ id: 'a', label: 'Claude Opus' }, { id: 'b', label: 'Other' }]
    expect(fuzzyFilter(models, 'opus', (m) => [m.id, m.label])).toEqual([models[0]])
  })
})
