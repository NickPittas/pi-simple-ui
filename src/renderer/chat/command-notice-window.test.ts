import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Win = typeof import('./command-notice-window.ts')
const T = 1_000_000
let w: Win

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T)
  w = await import('./command-notice-window.ts')
})
afterEach(() => { vi.useRealTimers() })

describe('command notice window', () => {
  it('is closed on a fresh module', () => {
    expect(w.isCommandNoticeWindowOpen()).toBe(false)
  })

  it('open lasts 20s with strict upper bound', () => {
    w.openCommandNoticeWindow()
    expect(w.isCommandNoticeWindowOpen()).toBe(true)
    vi.setSystemTime(T + 19_999)
    expect(w.isCommandNoticeWindowOpen()).toBe(true)
    vi.setSystemTime(T + 20_000)
    expect(w.isCommandNoticeWindowOpen()).toBe(false)
  })

  it('extend near the end pushes the deadline by 3s', () => {
    w.openCommandNoticeWindow()
    vi.setSystemTime(T + 19_000)
    w.extendCommandNoticeWindow()
    vi.setSystemTime(T + 21_999)
    expect(w.isCommandNoticeWindowOpen()).toBe(true)
    vi.setSystemTime(T + 22_000)
    expect(w.isCommandNoticeWindowOpen()).toBe(false)
  })

  it('extend never shortens the window', () => {
    w.openCommandNoticeWindow()
    vi.setSystemTime(T + 1_000)
    w.extendCommandNoticeWindow()
    vi.setSystemTime(T + 19_999)
    expect(w.isCommandNoticeWindowOpen()).toBe(true)
  })

  it('extend on a closed window opens it for 3s', () => {
    w.extendCommandNoticeWindow()
    vi.setSystemTime(T + 2_999)
    expect(w.isCommandNoticeWindowOpen()).toBe(true)
    vi.setSystemTime(T + 3_000)
    expect(w.isCommandNoticeWindowOpen()).toBe(false)
  })

  it('re-open resets to 20s from now', () => {
    w.openCommandNoticeWindow()
    vi.setSystemTime(T + 10_000)
    w.openCommandNoticeWindow()
    vi.setSystemTime(T + 29_999)
    expect(w.isCommandNoticeWindowOpen()).toBe(true)
    vi.setSystemTime(T + 30_000)
    expect(w.isCommandNoticeWindowOpen()).toBe(false)
  })
})
