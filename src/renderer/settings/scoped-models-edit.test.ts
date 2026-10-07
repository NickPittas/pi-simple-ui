import { describe, expect, it } from 'vitest'
import { moveEntry, parseEnabledModels, serializeEnabledModels, setProvider, toggleModel, unknownEntries } from './scoped-models-edit.ts'

const models = [{ provider: 'a', id: 'x', name: 'X' }, { provider: 'a', id: 'y', name: 'Y' }, { provider: 'b', id: 'z', name: 'Z' }]

describe('scoped-models-edit', () => {
  it('round trips preserving other keys and unknown entries', () => {
    const text = '{"theme":"dark","nested":{"k":[1]},"enabledModels":["a/x","gone/*"]}'
    const parsed = parseEnabledModels(text)
    expect(parsed).toEqual({ ok: true, enabled: ['a/x', 'gone/*'], present: true })
    const out = serializeEnabledModels(text, ['gone/*', 'b/z'])
    expect(out.ok && JSON.parse(out.text)).toEqual({ theme: 'dark', nested: { k: [1] }, enabledModels: ['gone/*', 'b/z'] })
    expect(out.ok && out.text.endsWith('\n')).toBe(true)
    expect(unknownEntries(['a/x', 'gone/*'], models)).toEqual(['gone/*'])
  })
  it('handles a missing key and empty text', () => {
    expect(parseEnabledModels('{"a":1}')).toEqual({ ok: true, enabled: [], present: false })
    const out = serializeEnabledModels('', ['a/x'])
    expect(out.ok && JSON.parse(out.text)).toEqual({ enabledModels: ['a/x'] })
  })
  it('returns errors for malformed input without throwing', () => {
    expect(parseEnabledModels('{oops').ok).toBe(false)
    expect(parseEnabledModels('[]').ok).toBe(false)
    expect(parseEnabledModels('{"enabledModels":"a"}').ok).toBe(false)
    expect(serializeEnabledModels('{oops', []).ok).toBe(false)
  })
  it('reorders within bounds only', () => {
    expect(moveEntry(['1', '2', '3'], 0, -1)).toEqual(['1', '2', '3'])
    expect(moveEntry(['1', '2', '3'], 2, 1)).toEqual(['1', '2', '3'])
    expect(moveEntry(['1', '2', '3'], 1, -1)).toEqual(['2', '1', '3'])
    expect(moveEntry(['1', '2', '3'], 0, 1)).toEqual(['2', '1', '3'])
  })
  it('toggles and provider select-all', () => {
    expect(toggleModel(['a/x'], 'a/x')).toEqual([])
    expect(toggleModel(['a/x'], 'b/z')).toEqual(['a/x', 'b/z'])
    expect(setProvider(['b/z', 'a/y'], models, 'a', true)).toEqual(['b/z', 'a/y', 'a/x'])
    expect(setProvider(['b/z', 'a/y', 'q'], models, 'a', false)).toEqual(['b/z', 'q'])
  })
})
