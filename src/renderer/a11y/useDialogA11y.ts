import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'

/** Keeps keyboard focus inside a modal and returns it to the opener when the modal closes. */
export function useDialogA11y<T extends HTMLElement>(ref: RefObject<T | null>, onEscape: () => void, enabled = true) {
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  useEffect(() => {
    if (!enabled) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Make every branch outside the modal's ancestor path inert. Preserve existing values
    // so nested or pre-inert application areas are restored exactly as they were.
    const inerted: Array<{ element: HTMLElement; wasInert: boolean }> = []
    let branch: HTMLElement | null = ref.current
    while (branch && branch !== document.body) {
      const parent: HTMLElement | null = branch.parentElement
      if (!parent) break
      for (const sibling of Array.from(parent.children)) {
        if (sibling instanceof HTMLElement && sibling !== branch) {
          inerted.push({ element: sibling, wasInert: sibling.inert })
          sibling.inert = true
        }
      }
      branch = parent
    }
    const frame = requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>('[data-dialog-initial-focus], button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')
      ;(first ?? ref.current)?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      for (const { element, wasInert } of inerted.reverse()) element.inert = wasInert
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus()
    }
  }, [enabled, ref])
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); escapeRef.current(); return }
    if (event.key !== 'Tab' || !enabled) return
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])].filter((item) => item.getAttribute('aria-hidden') !== 'true' && item.getAttribute('aria-disabled') !== 'true' && item.getClientRects().length > 0)
    if (!nodes.length) { event.preventDefault(); ref.current?.focus(); return }
    const first = nodes[0]!, last = nodes[nodes.length - 1]!
    if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
  }, [enabled, ref])
}
