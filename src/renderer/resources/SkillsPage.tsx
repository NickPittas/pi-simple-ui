import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { ResourceManager } from './ResourceManager.tsx'

export function SkillsPage({ bridge, scope, trusted = false }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly trusted?: boolean }) {
  return <ResourceManager kind="skill" bridge={bridge} scope={scope} trusted={trusted} />
}
