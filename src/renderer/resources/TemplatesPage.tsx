import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { ResourceManager } from './ResourceManager.tsx'

export function TemplatesPage({ bridge, scope, trusted = false }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly trusted?: boolean }) {
  return <ResourceManager kind="template" bridge={bridge} scope={scope} trusted={trusted} />
}
