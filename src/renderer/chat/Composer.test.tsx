// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { Composer, type ComposerProps } from './Composer.tsx'

afterEach(cleanup)

const scope: RuntimeScope = { ownerId: 'w1:owner', generation: 1 }

type Invoke = (capability: string, payload: unknown, scope?: RuntimeScope) => Promise<unknown>

function makeBridge(options: { path?: string | ((file: File) => string); invoke?: Invoke } = {}) {
  const invoke = vi.fn<Invoke>(options.invoke ?? (async () => ({ ok: true, value: { path: '/abs/x' } })))
  const pathForFile = options.path === undefined
    ? vi.fn((_file: File) => '')
    : vi.fn(typeof options.path === 'function' ? options.path : (_file: File) => options.path as string)
  const bridge = { appInfo: { name: 'test', version: '0' }, invoke, pathForFile, subscribe: vi.fn() } as unknown as DesktopBridge
  return { bridge, invoke, pathForFile }
}

function setup(bridge?: DesktopBridge, props: { nativeSubmit?: undefined; scopeValue?: RuntimeScope | undefined; readAttachment?: ComposerProps['readAttachment'] } = {}) {
  const onDraft = vi.fn()
  const nativeSubmit = 'nativeSubmit' in props ? props.nativeSubmit : vi.fn()
  const view = render(<Composer
    sessionId="s"
    onDraftChange={onDraft}
    busy={false}
    bridge={bridge}
    scope={'scopeValue' in props ? props.scopeValue : scope}
    nativeSubmit={nativeSubmit as never}
    readAttachment={props.readAttachment}
  />)
  const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement
  const composer = view.container.querySelector('.chat-composer') as HTMLElement
  return { ...view, onDraft, textarea, composer }
}

const pasteFiles = (textarea: HTMLTextAreaElement, ...files: File[]) => fireEvent.paste(textarea, { clipboardData: { files } })
const alertText = (container: HTMLElement) => container.querySelector('[role="alert"]')?.textContent

describe('Composer native attachment staging', () => {
  it('inserts the direct on-disk path without uploading', async () => {
    const { bridge, invoke } = makeBridge({ path: '/abs/a.png' })
    const { textarea } = setup(bridge)
    pasteFiles(textarea, new File(['ABC'], 'a.png', { type: 'image/png' }))
    await waitFor(() => expect(textarea.value).toBe('/abs/a.png'))
    expect(invoke).not.toHaveBeenCalled()
  })

  it('bypasses the size check when a direct path is available (current behaviour)', async () => {
    const { bridge, invoke } = makeBridge({ path: '/abs/big.png' })
    const { textarea, container } = setup(bridge)
    const file = new File(['ABC'], 'big.png', { type: 'image/png' })
    Object.defineProperty(file, 'size', { value: 7_500_001 })
    pasteFiles(textarea, file)
    await waitFor(() => expect(textarea.value).toBe('/abs/big.png'))
    expect(invoke).not.toHaveBeenCalled()
    expect(alertText(container)).toBeUndefined()
  })

  it('uploads in-memory files and inserts the staged path', async () => {
    const { bridge, invoke } = makeBridge({ invoke: async () => ({ ok: true, value: { path: '/staged/a.png' } }) })
    const { textarea } = setup(bridge)
    pasteFiles(textarea, new File(['ABC'], 'a.png', { type: 'image/png' }))
    await waitFor(() => expect(textarea.value).toBe('/staged/a.png'))
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('native.pi.stage-attachment', { name: 'a.png', bytesBase64: btoa('ABC') }, scope)
  })

  it('names nameless clipboard images pasted-image.<subtype>', async () => {
    const { bridge, invoke } = makeBridge()
    const { textarea } = setup(bridge)
    pasteFiles(textarea, new File(['x'], '', { type: 'image/png' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke.mock.calls[0][1]).toMatchObject({ name: 'pasted-image.png' })
  })

  it('sanitises the mime subtype used as a missing extension', async () => {
    const { bridge, invoke } = makeBridge()
    const { textarea } = setup(bridge)
    pasteFiles(textarea, new File(['x'], 'shot', { type: 'image/svg+xml' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke.mock.calls[0][1]).toMatchObject({ name: 'shot.svgxml' })
  })

  it('rejects oversize in-memory files without uploading', async () => {
    const { bridge, invoke } = makeBridge()
    const { textarea, container } = setup(bridge)
    const file = new File(['ABC'], 'a.png', { type: 'image/png' })
    Object.defineProperty(file, 'size', { value: 7_500_001 })
    pasteFiles(textarea, file)
    await waitFor(() => expect(alertText(container)).toBe('a.png is too large.'))
    expect(invoke).not.toHaveBeenCalled()
    expect(textarea.value).toBe('')
  })

  it('shows the upload error and inserts nothing when staging fails', async () => {
    const { bridge } = makeBridge({ invoke: async () => ({ ok: false, error: { code: 'INTERNAL', message: 'boom' } }) })
    const { textarea, container, onDraft } = setup(bridge)
    pasteFiles(textarea, new File(['ABC'], 'a.png', { type: 'image/png' }))
    await waitFor(() => expect(alertText(container)).toBe('boom'))
    expect(textarea.value).toBe('')
    expect(onDraft).not.toHaveBeenCalled()
  })

  it('joins several staged paths with newlines', async () => {
    const { bridge } = makeBridge({ path: (file) => `/abs/${file.name}` })
    const { textarea } = setup(bridge)
    pasteFiles(textarea, new File(['1'], 'a.png', { type: 'image/png' }), new File(['2'], 'b.png', { type: 'image/png' }))
    await waitFor(() => expect(textarea.value).toBe('/abs/a.png\n/abs/b.png'))
  })

  describe('insertion spacing', () => {
    const stageAbs = async (initial: string, caret?: number) => {
      const { bridge } = makeBridge({ path: '/abs/x' })
      const view = setup(bridge)
      fireEvent.change(view.textarea, { target: { value: initial } })
      if (caret !== undefined) view.textarea.setSelectionRange(caret, caret)
      pasteFiles(view.textarea, new File(['x'], 'x.png', { type: 'image/png' }))
      return view
    }

    it('adds a separating space after non-whitespace text', async () => {
      const { textarea } = await stageAbs('see')
      await waitFor(() => expect(textarea.value).toBe('see /abs/x'))
    })

    it('adds no extra space after text that ends in whitespace', async () => {
      const { textarea } = await stageAbs('see ')
      await waitFor(() => expect(textarea.value).toBe('see /abs/x'))
    })

    it('pads both sides when the caret is inside a word', async () => {
      const { textarea } = await stageAbs('ab', 1)
      await waitFor(() => expect(textarea.value).toBe('a /abs/x b'))
    })
  })

  it('reports the new text through onDraftChange', async () => {
    const { bridge } = makeBridge({ path: '/abs/a.png' })
    const { textarea, onDraft } = setup(bridge)
    pasteFiles(textarea, new File(['x'], 'a.png', { type: 'image/png' }))
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith('s', { text: '/abs/a.png' }))
  })

  it.each([
    ['bridge', undefined, scope],
    ['scope', makeBridge().bridge, undefined],
  ])('is unavailable without a %s', async (_name, bridge, scopeValue) => {
    const { textarea, container } = setup(bridge, { scopeValue })
    pasteFiles(textarea, new File(['x'], 'a.png', { type: 'image/png' }))
    await waitFor(() => expect(alertText(container)).toBe('Attachments are unavailable without an active runtime.'))
    expect(textarea.value).toBe('')
  })

  it('stages dropped files through the same path', async () => {
    const { bridge, invoke } = makeBridge({ path: '/abs/dropped.png' })
    const { composer, textarea } = setup(bridge)
    fireEvent.drop(composer, { dataTransfer: { files: [new File(['x'], 'dropped.png', { type: 'image/png' })] } })
    await waitFor(() => expect(textarea.value).toBe('/abs/dropped.png'))
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('Composer non-native attachment validation', () => {
  const readAttachment = vi.fn()

  it('rejects non-image files', async () => {
    const { textarea, container } = setup(undefined, { nativeSubmit: undefined, readAttachment })
    pasteFiles(textarea, new File(['x'], 'x.txt', { type: 'text/plain' }))
    await waitFor(() => expect(alertText(container)).toBe('x.txt is not supported here. Only image attachments can be sent.'))
    expect(readAttachment).not.toHaveBeenCalled()
  })

  it('rejects images with a disallowed mime type', async () => {
    const { textarea, container } = setup(undefined, { nativeSubmit: undefined, readAttachment })
    pasteFiles(textarea, new File(['x'], 'x.png', { type: 'image/svg+xml' }))
    await waitFor(() => expect(alertText(container)).toBe('x.png has an unsupported type or size.'))
    expect(readAttachment).not.toHaveBeenCalled()
  })

  it('reports a missing attachment reader for an otherwise valid image', async () => {
    const { textarea, container } = setup(undefined, { nativeSubmit: undefined })
    pasteFiles(textarea, new File(['x'], 'x.png', { type: 'image/png' }))
    await waitFor(() => expect(alertText(container)).toBe('Attachment reading is not connected.'))
  })
})
