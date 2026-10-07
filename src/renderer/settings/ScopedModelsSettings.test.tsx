// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { ScopedModelsSettings } from './ScopedModelsSettings.tsx'

afterEach(cleanup)
const scope = { ownerId: 'o', generation: 1 } as unknown as RuntimeScope
const models = [{ provider: 'a', id: 'x', name: 'X' }, { provider: 'a', id: 'y', name: 'Y' }]
const file = '{"theme":"dark","enabledModels":["a/x","old/gone"]}'

describe('ScopedModelsSettings', () => {
  it('shows enabled list, and saves only enabledModels', async () => {
    const invoke = vi.fn(async (name: string) => name === 'native.config.read'
      ? { ok: true, value: { id: 'user:settings.json', text: file, revision: 'r'.padEnd(64, '0'), exists: true } }
      : { ok: true, value: { outcome: 'saved', revision: '1'.repeat(64), reason: null } })
    render(<ScopedModelsSettings bridge={{ invoke } as unknown as DesktopBridge} scope={scope} allModels={models} />)
    await screen.findByText('old/gone')
    expect(screen.getByText('not in catalogue')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Remove a/x'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'y' }))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('native.config.write', expect.anything(), scope))
    const call = invoke.mock.calls.find((c) => c[0] === 'native.config.write') as unknown as [string, { id: string; text: string; expectedRevision: string }]
    expect(call[1].id).toBe('user:settings.json')
    expect(JSON.parse(call[1].text)).toEqual({ theme: 'dark', enabledModels: ['old/gone', 'a/y'] })
    await screen.findByText('Restart Pi to apply')
  })
})
