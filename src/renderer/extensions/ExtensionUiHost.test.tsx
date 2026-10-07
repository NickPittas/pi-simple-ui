// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionUIEvent } from '../../shared/extension-ui'
import type { RuntimeScope } from '../../shared/ipc-contracts'
import { openCommandNoticeWindow } from '../chat/command-notice-window.ts'
import { ExtensionUiHost, type ExtensionUiTransport } from './ExtensionUiHost'

vi.mock('./NativeCustomTerminal', () => ({ NativeCustomTerminal: () => null }))
vi.mock('./adapters', () => ({ SemanticViewRenderer: () => null }))

const scope: RuntimeScope = { ownerId: 'o', generation: 1 }
// Window state is module-global: move the fake clock 60s further on for every test.
let clock = 5_000_000
let emit: (event: ExtensionUIEvent) => void

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 60_000
  vi.setSystemTime(clock)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function setup() {
  const subscribe = vi.fn(async (_channel: string, _scope: unknown, listener: (e: ExtensionUIEvent) => void) => {
    emit = listener
    return { ok: true as const, value: vi.fn() }
  })
  const invoke = vi.fn(async () => ({ ok: true as const, value: null }))
  const transport = { subscribe, invoke } as unknown as ExtensionUiTransport
  const view = render(<ExtensionUiHost scope={scope} transport={transport} />)
  await act(async () => {})
  return view
}
const send = (event: ExtensionUIEvent) => act(() => { emit(event) })
const notice = (message: string, level: 'info' | 'warning' | 'error' = 'info'): ExtensionUIEvent => ({ type: 'notification', message, level })
const noticeTexts = (c: HTMLElement) => Array.from(c.querySelectorAll('.extension-notice-list > li')).map((li) => li.textContent ?? '')

describe('ExtensionUiHost notices vs inline command notices', () => {
  it('shows notifications in the panel when the window is closed', async () => {
    const { container } = await setup()
    await send(notice('panel-msg'))
    const li = container.querySelector('.extension-notice-list li')!
    expect(li.textContent).toContain('panel-msg')
    expect(li.classList.contains('extension-notice-info')).toBe(true)
  })

  it('suppresses notifications while the window is open, keeps earlier ones, still shows status', async () => {
    const { container } = await setup()
    await send(notice('panel-msg'))
    openCommandNoticeWindow()
    await send(notice('inline-msg'))
    const texts = noticeTexts(container)
    expect(texts.some((t) => t.includes('panel-msg'))).toBe(true)
    expect(texts.some((t) => t.includes('inline-msg'))).toBe(false)
    await send({ type: 'status', key: 'k', text: 'v' })
    expect(container.querySelector('.extension-status-list')!.textContent).toContain('v')
  })

  it('shows notifications again after the window expires', async () => {
    const { container } = await setup()
    openCommandNoticeWindow()
    vi.setSystemTime(clock + 20_000)
    await send(notice('after'))
    expect(noticeTexts(container).some((t) => t.includes('after'))).toBe(true)
  })

  it('uses alert role for errors and status role for warnings', async () => {
    const { container } = await setup()
    await send(notice('e', 'error'))
    await send(notice('w', 'warning'))
    const [err, warn] = Array.from(container.querySelectorAll('.extension-notice-list > li'))
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.className).toBe('extension-notice extension-notice-error')
    expect(warn.getAttribute('role')).toBe('status')
  })

  it('retains only the last 12 notifications', async () => {
    const { container } = await setup()
    for (let i = 1; i <= 13; i++) await send(notice(`m${i}`))
    const texts = noticeTexts(container)
    expect(texts).toHaveLength(12)
    expect(texts[0]).toContain('m2')
    expect(texts.at(-1)).toContain('m13')
  })
})
