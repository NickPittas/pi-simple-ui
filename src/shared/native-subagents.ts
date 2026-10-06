export type SubagentTranscriptRequest = { file: string }
export type SubagentTranscriptEntry = { id: string; timestamp: string | null; message: unknown }
export type SubagentTranscriptResult = {
  file: string
  format: 'pi-session' | 'herdr-transcript' | 'tintinweb-output'
  entries: SubagentTranscriptEntry[]
  truncated: boolean
  bytes: number
  modified: string
  error: string | null
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts {
    'native.subagent.transcript': { readonly request: SubagentTranscriptRequest; readonly response: SubagentTranscriptResult }
  }
}

import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export const SUBAGENT_TRANSCRIPT_MAX_ENTRIES = 1000
export const SUBAGENT_TRANSCRIPT_MAX_ID = 256

export function isSubagentTranscriptRequest(value: unknown): value is SubagentTranscriptRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['file'])
    && typeof value.file === 'string' && value.file.length > 0 && value.file.length <= 4096
}

export function isSubagentTranscriptEntry(value: unknown): value is SubagentTranscriptEntry {
  return isPlainRecord(value) && hasExactKeys(value, ['id', 'timestamp', 'message'])
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= SUBAGENT_TRANSCRIPT_MAX_ID
    && (value.timestamp === null || typeof value.timestamp === 'string')
}

export function isSubagentTranscriptResult(value: unknown): value is SubagentTranscriptResult {
  return isPlainRecord(value)
    && hasExactKeys(value, ['file', 'format', 'entries', 'truncated', 'bytes', 'modified', 'error'])
    && typeof value.file === 'string'
    && (value.format === 'pi-session' || value.format === 'herdr-transcript' || value.format === 'tintinweb-output')
    && Array.isArray(value.entries) && value.entries.length <= SUBAGENT_TRANSCRIPT_MAX_ENTRIES
    && value.entries.every(isSubagentTranscriptEntry)
    && typeof value.truncated === 'boolean'
    && typeof value.bytes === 'number' && Number.isFinite(value.bytes) && value.bytes >= 0
    && typeof value.modified === 'string'
    && (value.error === null || typeof value.error === 'string')
}
