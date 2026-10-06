import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

export interface UICompanionExtension {
  readonly factory: ExtensionFactory
  abortSelection(): void
}

/** Native SDK command fixture used to exercise the desktop ExtensionUIContext bridge. */
export function createUICompanionExtension(): UICompanionExtension {
  let activeAbortController: AbortController | undefined
  const factory: ExtensionFactory = (pi) => {
    pi.registerCommand('ui-companion', {
      description: 'Exercise the native extension UI bridge fixture.',
      handler: async (args, ctx) => {
        const scenario = args.trim()
        if (scenario === 'timeout-select') {
          const choice = await ctx.ui.select('Timed selection', ['wait', 'continue'], { timeout: 25 })
          ctx.ui.notify(`selection:${choice ?? '<cancelled>'}`)
          return
        }
        if (scenario === 'abort-select') {
          activeAbortController = new AbortController()
          const choice = await ctx.ui.select('Abortable selection', ['wait', 'continue'], {
            signal: activeAbortController.signal,
          })
          ctx.ui.notify(`selection:${choice ?? '<cancelled>'}`)
          activeAbortController = undefined
          return
        }
        if (scenario === 'cancel-select') {
          const choice = await ctx.ui.select('Cancelable selection', ['wait', 'continue'])
          ctx.ui.notify(`selection:${choice ?? '<cancelled>'}`)
          return
        }
        if (scenario === 'cancel-editor') {
          const edited = await ctx.ui.editor('Cancelable editor', 'unsaved notes')
          ctx.ui.notify(`editor:${edited ?? '<cancelled>'}`)
          return
        }

        const choice = await ctx.ui.select('Choose an execution mode', ['precise', 'fast'])
        const input = await ctx.ui.input('Name this run', 'run name')
        const confirmed = await ctx.ui.confirm('Confirm run', `Run ${input ?? '<cancelled>'}?`)
        const edited = await ctx.ui.editor('Edit run notes', 'initial notes')
        ctx.ui.setStatus('ui-companion', 'bridge completed')
        ctx.ui.setWidget('ui-companion', ['native widget line'], { placement: 'belowEditor' })
        ctx.ui.setTitle('Pi Desktop Companion — UI fixture')
        ctx.ui.notify(JSON.stringify({ choice, input, confirmed, edited }))
      },
    })
  }

  return {
    factory,
    abortSelection() {
      activeAbortController?.abort()
    },
  }
}
