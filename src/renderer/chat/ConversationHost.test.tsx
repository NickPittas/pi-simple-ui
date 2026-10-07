// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { createNativeConversation, type NativeConversation } from './native-conversation.ts'
import { ConversationHost } from './ConversationHost.tsx'

const host = vi.hoisted(() => ({ state: undefined as unknown as NativeConversation }))

vi.mock('./useNativeConversations.ts', () => ({
  useNativeConversations: () => ({
    state: host.state,
    report: { duplicates: [], gaps: [], stale: [], droppedLateEvents: [] },
    error: null,
    refresh: async () => undefined,
  }),
}))
vi.mock('./Conversation', () => ({
  Conversation: ({ messages }: { messages: ReadonlyArray<{ id: string; role: string; content: string; customType?: string; level?: string }> }) => (
    <ol>{messages.map((m) => <li key={m.id} data-id={m.id} data-role={m.role} data-custom={m.customType ?? ''} data-level={m.level ?? ''}>{m.content}</li>)}</ol>
  ),
}))
vi.mock('./Composer', () => ({
  Composer: ({ nativeSubmit }: { nativeSubmit: (text: string) => Promise<unknown> }) => (
    <div>
      <button type="button" onClick={() => void nativeSubmit('/cmd').catch(() => {})}>slash</button>
      <button type="button" onClick={() => void nativeSubmit('hello').catch(() => {})}>plain</button>
      <button type="button" onClick={() => void nativeSubmit('  /ws').catch(() => {})}>ws</button>
    </div>
  ),
}))
vi.mock('../extensions/NativePiTerminal.tsx', () => ({ NativePiTerminal: () => null }))
vi.mock('../workers/InlineWorkerConversations.tsx', () => ({ InlineWorkerConversations: () => null }))
vi.mock('./SubagentConversation.tsx', () => ({ SubagentConversation: () => null }))
vi.mock('../workers/ObservedSubagentsPage.tsx', () => ({ ObservedSubagentsPage: () => null }))

const scope: RuntimeScope = { ownerId: 'w1:owner', generation: 1 }
type Listener = (event: unknown) => void

const msg = (id: string) => ({ id, role: 'user', content: id, nativeEntryType: 'message' }) as unknown as NativeConversation['messages'][number]
const makeState = (ids: string[], sessionId = 's1'): NativeConversation => ({
  ...createNativeConversation(), sessionId, generation: 1, root: 'root', messages: ids.map(msg),
})

let listener: Listener
let stop: ReturnType<typeof vi.fn>
let subscribe: ReturnType<typeof vi.fn>
let bridge: DesktopBridge
let now: number
let base = 1_000_000

const setNow = (value: number) => { now = value; vi.setSystemTime(now) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  base += 1_000_000 // each test starts after the previous test's window expired
  now = base
  vi.setSystemTime(now)
  host.state = makeState(['m1'])
  stop = vi.fn()
  subscribe = vi.fn((_event: string, _scope: unknown, cb: Listener) => { listener = cb; return Promise.resolve({ ok: true, value: stop }) })
  bridge = {
    appInfo: { name: 't', version: '0' },
    subscribe,
    invoke: vi.fn(async () => ({ ok: true, value: { requestId: 'r', outcome: 'accepted', reason: null } })),
  } as unknown as DesktopBridge
})

afterEach(() => {
  cleanup()
  // The notice window is module state shared across this file; let it expire.
  vi.setSystemTime(now + 60_000)
  vi.useRealTimers()
})

async function mount() {
  const view = render(<ConversationHost bridge={bridge} scope={scope} />)
  await act(async () => {})
  return view
}
const items = (c: HTMLElement) => Array.from(c.querySelectorAll('li')) as HTMLLIElement[]
const ids = (c: HTMLElement) => items(c).map((li) => li.dataset.id!.startsWith('notice:') ? 'N:' + li.textContent : li.dataset.id)
const notify = (message: string, level: 'info' | 'warning' | 'error' = 'info') => act(() => { listener({ type: 'notification', level, message }) })
const click = async (c: HTMLElement, label: string) => {
  const button = Array.from(c.querySelectorAll('button')).find((b) => b.textContent === label)!
  await act(async () => { fireEvent.click(button) })
}

describe('ConversationHost inline command notices', () => {
  it('subscribes once to extension.ui with the scope', async () => {
    await mount()
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls[0][0]).toBe('extension.ui')
    expect(subscribe.mock.calls[0][1]).toEqual(scope)
  })

  it('ignores notifications while the window is closed', async () => {
    const { container } = await mount()
    await notify('early')
    expect(ids(container)).toEqual(['m1'])
  })

  it('renders a notice right after the last message following a slash submit', async () => {
    const { container } = await mount()
    await click(container, 'slash')
    await notify('ok')
    const [, notice] = items(container)
    expect(ids(container)).toEqual(['m1', 'N:ok'])
    expect(notice.dataset.id!.startsWith('notice:')).toBe(true)
    expect(notice.dataset.role).toBe('system')
    expect(notice.dataset.custom).toBe('command-notice')
    expect(notice.dataset.level).toBe('info')
  })

  it.each([
    ['error', 'error'],
    ['warning', 'system'],
  ] as const)('maps %s level to role %s', async (level, role) => {
    const { container } = await mount()
    await click(container, 'slash')
    await notify('x', level)
    expect(items(container)[1].dataset.role).toBe(role)
    expect(items(container)[1].dataset.level).toBe(level)
  })

  it('does not open the window for a plain submit', async () => {
    const { container } = await mount()
    await click(container, 'plain')
    await notify('nope')
    expect(ids(container)).toEqual(['m1'])
  })

  it('opens the window for a slash command after leading whitespace', async () => {
    const { container } = await mount()
    await click(container, 'ws')
    await notify('ok')
    expect(ids(container)).toEqual(['m1', 'N:ok'])
  })

  it('ignores non-notification events even while open', async () => {
    const { container } = await mount()
    await click(container, 'slash')
    await act(() => { listener({ type: 'status', key: 'k', text: 't' }) })
    expect(ids(container)).toEqual(['m1'])
  })

  it('keeps notices sharing an anchor in arrival order before later messages', async () => {
    const { container, rerender } = await mount()
    await click(container, 'slash')
    await notify('N1')
    await notify('N2')
    host.state = makeState(['m1', 'm2'])
    rerender(<ConversationHost bridge={bridge} scope={scope} />)
    expect(ids(container)).toEqual(['m1', 'N:N1', 'N:N2', 'm2'])
  })

  it('inserts a notice with no messages at index 0 and keeps it first', async () => {
    host.state = makeState([])
    const { container, rerender } = await mount()
    await click(container, 'slash')
    await notify('first')
    expect(ids(container)).toEqual(['N:first'])
    host.state = makeState(['m1'])
    rerender(<ConversationHost bridge={bridge} scope={scope} />)
    expect(ids(container)).toEqual(['N:first', 'm1'])
  })

  it('appends a notice at the end when its anchor disappears', async () => {
    const { container, rerender } = await mount()
    await click(container, 'slash')
    await notify('orphan')
    host.state = makeState(['m2', 'm3'])
    rerender(<ConversationHost bridge={bridge} scope={scope} />)
    expect(ids(container)).toEqual(['m2', 'm3', 'N:orphan'])
  })

  it('extends the window on accepted notifications and expires it otherwise', async () => {
    const { container } = await mount()
    await click(container, 'slash')
    const submitted = now
    setNow(submitted + 19_999)
    await notify('late-but-ok')
    expect(ids(container)).toEqual(['m1', 'N:late-but-ok'])
    setNow(submitted + 19_999 + 22_000)
    await notify('too-late')
    expect(ids(container)).toEqual(['m1', 'N:late-but-ok'])
  })

  it('caps rendered notices at the last 50', async () => {
    const { container } = await mount()
    await click(container, 'slash')
    for (let i = 0; i < 51; i++) await notify(`n${i}`)
    const notices = ids(container).filter((id) => id!.startsWith('N:'))
    expect(notices).toHaveLength(50)
    expect(notices[0]).toBe('N:n1')
    expect(notices.at(-1)).toBe('N:n50')
  })

  it('clears notices when the session changes', async () => {
    const { container, rerender } = await mount()
    await click(container, 'slash')
    await notify('ok')
    expect(ids(container)).toEqual(['m1', 'N:ok'])
    host.state = makeState(['m1'], 's2')
    rerender(<ConversationHost bridge={bridge} scope={scope} />)
    expect(ids(container)).toEqual(['m1'])
  })

  it('stops the subscription once on unmount', async () => {
    const { unmount } = await mount()
    expect(stop).not.toHaveBeenCalled()
    unmount()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
