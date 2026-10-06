import type { CapabilityDefinition } from './register.ts'
import { readSubagentTranscript } from '../pi/subagent-transcripts.ts'
import { isSubagentTranscriptRequest, isSubagentTranscriptResult } from '../../shared/native-subagents.ts'

export function registerNativeSubagentCapabilities(): CapabilityDefinition<any, any>[] {
  return [
    {
      id: 'native.subagent.transcript', scope: 'runtime',
      validateRequest: isSubagentTranscriptRequest, validateResponse: isSubagentTranscriptResult,
      handle: async (_context, request) => readSubagentTranscript(request.file),
    },
  ]
}
