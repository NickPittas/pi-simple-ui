import { CustomEditor } from '@earendil-works/pi-coding-agent'
import type { KeybindingsManager } from '@earendil-works/pi-coding-agent'
import type { Editor, EditorTheme, TUI } from '@earendil-works/pi-tui'

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => Editor
type NativeInputUi = {
  getEditorComponent(): EditorFactory | undefined
  setEditorComponent(factory: EditorFactory | undefined): void
  getFocusedComponent(): unknown
}
type NativeInputResult =
  | { outcome: 'submitted' }
  | { outcome: 'rejected'; reason: string }

/**
 * Captures Pi's installed editor seam: `factory(this.ui, getEditorTheme(), this.keybindings)`
 * (interactive-mode.js:2208); Pi then calls `this.ui.setFocus(this.editor)` (line 2264).
 */
export function bindNativeInput(ui: NativeInputUi): {
  submit(text: string): NativeInputResult
  dispose(): void
} {
  const priorFactory = ui.getEditorComponent()
  let capturedEditor: Editor | undefined
  let capturedTui: TUI | undefined
  let installed = false
  let disposed = false

  const ourFactory: EditorFactory = (tui, theme, keybindings) => {
    capturedTui = tui
    capturedEditor = priorFactory
      ? priorFactory(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true })
    // After factory return Pi copies `newEditor.onSubmit = this.defaultEditor.onSubmit;`,
    // `newEditor.setText(currentText);`, and live change/appearance/autocomplete values.
    // Constructor options may evolve; these post-factory copies mitigate those version differences.
    // Return the editor unchanged so Pi itself performs all behavioral wiring.
    return capturedEditor
  }

  ui.setEditorComponent(ourFactory)
  installed = true

  return {
    submit(text) {
      if (!installed || disposed) return { outcome: 'rejected', reason: 'native input not bound' }
      if (!capturedEditor || !capturedTui) return { outcome: 'rejected', reason: 'no captured editor' }
      // Identity focus fencing works across jiti realms without instanceof guesses.
      if (capturedTui.getFocusedComponent() !== capturedEditor) return { outcome: 'rejected', reason: 'stale focus' }
      if (typeof capturedEditor.onSubmit !== 'function') return { outcome: 'rejected', reason: 'missing submit callback' }

      // Never inject Enter. Stage user-typed state, then mirror Pi's source order:
      // `this.editor.setText(""); this.editor.onSubmit(text);` (interactive-mode.js:3616-3617).
      capturedEditor.setText(text)
      capturedEditor.setText('')
      capturedEditor.onSubmit(text)
      return { outcome: 'submitted' }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (ui.getEditorComponent() === ourFactory) {
        // Pi documents undefined as restoring its default editor path.
        ui.setEditorComponent(priorFactory)
      } else {
        try { console.warn('native input: another editor factory is installed; leaving it intact') } catch {}
      }
      installed = false
      capturedEditor = undefined
      capturedTui = undefined
    },
  }
}
