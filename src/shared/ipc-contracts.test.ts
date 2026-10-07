import { describe, expect, it } from 'vitest'
import {
  hasExactKeys,
  ipcFailure,
  isCapabilityId,
  isIpcResult,
  isMatchingEventEnvelope,
  isPlainRecord,
  isRuntimeScope,
  isSubscriptionId,
} from './ipc-contracts.ts'

describe('isPlainRecord', () => {
  it('accepts only plain objects', () => {
    expect(isPlainRecord({})).toBe(true)
    expect(isPlainRecord(Object.create(null))).toBe(true)
    class C {}
    for (const v of [[], null, new Date(), new C()]) expect(isPlainRecord(v)).toBe(false)
  })
})

describe('hasExactKeys', () => {
  it('is order independent and strict', () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ['b', 'a'])).toBe(true)
    expect(hasExactKeys({ a: 1, b: 2 }, ['a'])).toBe(false)
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false)
  })
})

describe('id validators', () => {
  it('validates capability ids', () => {
    expect(isCapabilityId('native.pi.stage-attachment')).toBe(true)
    expect(isCapabilityId('a'.repeat(64))).toBe(true)
    for (const v of ['', 'Native.x', '1abc', 'a_b', 'a'.repeat(65)]) expect(isCapabilityId(v)).toBe(false)
  })

  it('validates subscription ids', () => {
    expect(isSubscriptionId('abc-123')).toBe(true)
    expect(isSubscriptionId('a'.repeat(80))).toBe(true)
    for (const v of ['', 'a_b', 'a'.repeat(81)]) expect(isSubscriptionId(v)).toBe(false)
  })
})

describe('isRuntimeScope', () => {
  it('validates scope shape', () => {
    expect(isRuntimeScope({ ownerId: 'w1:abc.d-e', generation: 0 })).toBe(true)
    for (const v of [
      { ownerId: 'a', generation: 0, x: 1 },
      { ownerId: 'a', generation: -1 },
      { ownerId: 'a', generation: 1.5 },
      { ownerId: '', generation: 0 },
      { ownerId: 'a b', generation: 0 },
      { ownerId: 'a'.repeat(129), generation: 0 },
    ]) expect(isRuntimeScope(v)).toBe(false)
  })
})

describe('isMatchingEventEnvelope', () => {
  const scope = { ownerId: 'w1', generation: 1 }
  const base = { event: 'native.pi.event', subscriptionId: 'sub-1', payload: 1 }
  const expected = { event: 'native.pi.event', subscriptionId: 'sub-1' }

  it('matches event, subscription and scope', () => {
    expect(isMatchingEventEnvelope(base, expected)).toBe(true)
    expect(isMatchingEventEnvelope({ ...base, scope }, { ...expected, scope: { ...scope } })).toBe(true)
  })

  it('rejects mismatches', () => {
    expect(isMatchingEventEnvelope({ ...base, scope: { ...scope, generation: 2 } }, { ...expected, scope })).toBe(false)
    expect(isMatchingEventEnvelope({ ...base, scope }, expected)).toBe(false)
    expect(isMatchingEventEnvelope(base, { ...expected, scope })).toBe(false)
    expect(isMatchingEventEnvelope({ ...base, extra: 1 }, expected)).toBe(false)
    expect(isMatchingEventEnvelope({ ...base, subscriptionId: 'other' }, expected)).toBe(false)
  })
})

describe('isIpcResult / ipcFailure', () => {
  it('validates results', () => {
    expect(isIpcResult({ ok: true, value: 1 })).toBe(true)
    expect(isIpcResult({ ok: false, error: { code: 'INTERNAL', message: 'x' } })).toBe(true)
    expect(isIpcResult({ ok: false, error: { code: 'NOPE', message: '' } })).toBe(false)
    expect(isIpcResult({ ok: false, error: { code: 'INTERNAL', message: 'x'.repeat(161) } })).toBe(false)
    expect(isIpcResult({ ok: true })).toBe(false)
  })

  it('truncates failure messages to 160 characters', () => {
    const r = ipcFailure('INTERNAL', 'x'.repeat(500))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toHaveLength(160)
    expect(isIpcResult(r)).toBe(true)
  })
})
