export type NativeConfigFile = {
  id: string
  scope: 'user' | 'project'
  group: 'pi' | 'extension'
  label: string
  path: string
  exists: boolean
  sensitive: boolean
}
export type NativeConfigListRequest = Record<string, never>
export type NativeConfigListResult = { files: NativeConfigFile[] }
export type NativeConfigReadRequest = { id: string }
export type NativeConfigReadResult = { id: string; text: string; revision: string; exists: boolean }
export type NativeConfigWriteRequest = { id: string; text: string; expectedRevision: string }
export type NativeConfigWriteResult = {
  outcome: 'saved' | 'conflict' | 'invalid' | 'rejected'
  revision: string | null
  reason: string | null
}
export type NativePiRestartRequest = Record<string, never>
export type NativePiRestartResult = { outcome: 'restarted' | 'rejected'; reason: string | null }

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts {
    'native.config.list': { readonly request: NativeConfigListRequest; readonly response: NativeConfigListResult }
    'native.config.read': { readonly request: NativeConfigReadRequest; readonly response: NativeConfigReadResult }
    'native.config.write': { readonly request: NativeConfigWriteRequest; readonly response: NativeConfigWriteResult }
    'native.pi.restart': { readonly request: NativePiRestartRequest; readonly response: NativePiRestartResult }
  }
}

import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export const NATIVE_CONFIG_MAX_BYTES = 2 * 1024 * 1024
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const revision = (value: unknown): value is string => typeof value === 'string' && (value === '' || /^[0-9a-f]{64}$/.test(value))

export function isNativeConfigEmptyRequest(value: unknown): value is Record<string, never> {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

export function isNativeConfigFile(value: unknown): value is NativeConfigFile {
  return isPlainRecord(value) && hasExactKeys(value, ['id', 'scope', 'group', 'label', 'path', 'exists', 'sensitive'])
    && nonempty(value.id) && (value.scope === 'user' || value.scope === 'project')
    && (value.group === 'pi' || value.group === 'extension') && nonempty(value.label) && nonempty(value.path)
    && typeof value.exists === 'boolean' && typeof value.sensitive === 'boolean'
}

export function isNativeConfigListResult(value: unknown): value is NativeConfigListResult {
  return isPlainRecord(value) && hasExactKeys(value, ['files']) && Array.isArray(value.files) && value.files.every(isNativeConfigFile)
}

export function isNativeConfigReadRequest(value: unknown): value is NativeConfigReadRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['id']) && nonempty(value.id) && value.id.length <= 256
}

export function isNativeConfigReadResult(value: unknown): value is NativeConfigReadResult {
  return isPlainRecord(value) && hasExactKeys(value, ['id', 'text', 'revision', 'exists'])
    && nonempty(value.id) && typeof value.text === 'string' && revision(value.revision) && typeof value.exists === 'boolean'
}

export function isNativeConfigWriteRequest(value: unknown): value is NativeConfigWriteRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['id', 'text', 'expectedRevision'])
    && nonempty(value.id) && value.id.length <= 256 && typeof value.text === 'string'
    && value.text.length <= NATIVE_CONFIG_MAX_BYTES && revision(value.expectedRevision)
}

export function isNativeConfigWriteResult(value: unknown): value is NativeConfigWriteResult {
  return isPlainRecord(value) && hasExactKeys(value, ['outcome', 'revision', 'reason'])
    && ['saved', 'conflict', 'invalid', 'rejected'].includes(value.outcome as string)
    && nullableString(value.revision) && nullableString(value.reason)
}

export function isNativePiRestartResult(value: unknown): value is NativePiRestartResult {
  return isPlainRecord(value) && hasExactKeys(value, ['outcome', 'reason'])
    && (value.outcome === 'restarted' || value.outcome === 'rejected') && nullableString(value.reason)
}
