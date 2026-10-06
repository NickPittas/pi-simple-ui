import type { CapabilityDefinition } from './register.ts'
import type { NativeConfigFiles } from '../config/native-config-files.ts'
import {
  isNativeConfigEmptyRequest,
  isNativeConfigListResult,
  isNativeConfigReadRequest,
  isNativeConfigReadResult,
  isNativeConfigWriteRequest,
  isNativeConfigWriteResult,
  isNativePiRestartResult,
} from '../../shared/native-config.ts'
import type { NativePiRestartResult } from '../../shared/native-config.ts'

export function registerNativeConfigCapabilities(
  files: NativeConfigFiles,
  restart: () => Promise<NativePiRestartResult>,
): CapabilityDefinition<any, any>[] {
  return [
    {
      id: 'native.config.list', scope: 'runtime', validateRequest: isNativeConfigEmptyRequest, validateResponse: isNativeConfigListResult,
      handle: async () => files.list(),
    },
    {
      id: 'native.config.read', scope: 'runtime', validateRequest: isNativeConfigReadRequest, validateResponse: isNativeConfigReadResult,
      handle: async (_context, request) => files.read(request.id),
    },
    {
      id: 'native.config.write', scope: 'runtime', validateRequest: isNativeConfigWriteRequest, validateResponse: isNativeConfigWriteResult,
      handle: async (_context, request) => files.write(request.id, request.text, request.expectedRevision),
    },
    {
      // Window scope: a successful restart replaces the runtime generation the caller was scoped to.
      id: 'native.pi.restart', scope: 'window', validateRequest: isNativeConfigEmptyRequest, validateResponse: isNativePiRestartResult,
      handle: async () => restart(),
    },
  ]
}
