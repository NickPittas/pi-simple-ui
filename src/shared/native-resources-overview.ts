import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export type ResourceTypeName = 'extensions' | 'skills' | 'prompts' | 'themes'
export type OverviewPackageFilter = { type: ResourceTypeName; patterns: string[] }
export type OverviewPackage = {
  /** Package source as written in settings.json, with URL userinfo/query redacted. */
  source: string
  kind: 'npm' | 'git' | 'local' | 'other'
  scope: 'user' | 'project'
  /** Pinned npm version/range or git ref from the source string; null when unpinned. */
  pin: string | null
  filters: OverviewPackageFilter[]
  installedPath: string | null
  installed: boolean
  packageVersion: string | null
  /** Counts from Pi's own get_commands sourceInfo; null when Pi commands were unavailable. */
  contributions: { commands: number; skills: number; prompts: number } | null
  /** Entries in the package.json `pi.extensions` manifest; null when no manifest. */
  manifestExtensions: number | null
}
export type OverviewNamedItem = { name: string; scope: 'user' | 'project' }
export type OverviewContextFile = { path: string; scope: 'user' | 'project'; bytes: number }
export type NativeResourcesOverview = {
  workspacePath: string | null
  packages: OverviewPackage[]
  topLevel: { skills: OverviewNamedItem[]; prompts: OverviewNamedItem[]; extensions: OverviewNamedItem[]; themes: OverviewNamedItem[] }
  contextFiles: OverviewContextFile[]
  errors: { packages: string | null; commands: string | null; topLevel: string | null; contextFiles: string | null }
}
export type NativeResourcesOverviewRequest = Record<string, never>

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts {
    'native.resources.overview': { readonly request: NativeResourcesOverviewRequest; readonly response: NativeResourcesOverview }
  }
}

const str = (v: unknown): v is string => typeof v === 'string'
const nstr = (v: unknown): v is string | null => v === null || typeof v === 'string'
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const scopeOk = (v: unknown): v is 'user' | 'project' => v === 'user' || v === 'project'
const arrayOf = <T>(v: unknown, check: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(check)

export function isNativeResourcesOverviewRequest(value: unknown): value is NativeResourcesOverviewRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}
const isFilter = (v: unknown): v is OverviewPackageFilter => isPlainRecord(v) && hasExactKeys(v, ['type', 'patterns'])
  && ['extensions', 'skills', 'prompts', 'themes'].includes(v.type as string) && arrayOf(v.patterns, str)
const isContrib = (v: unknown): boolean => isPlainRecord(v) && hasExactKeys(v, ['commands', 'skills', 'prompts'])
  && count(v.commands) && count(v.skills) && count(v.prompts)
const isPackage = (v: unknown): v is OverviewPackage => isPlainRecord(v)
  && hasExactKeys(v, ['source', 'kind', 'scope', 'pin', 'filters', 'installedPath', 'installed', 'packageVersion', 'contributions', 'manifestExtensions'])
  && str(v.source) && ['npm', 'git', 'local', 'other'].includes(v.kind as string) && scopeOk(v.scope) && nstr(v.pin)
  && arrayOf(v.filters, isFilter) && nstr(v.installedPath) && typeof v.installed === 'boolean' && nstr(v.packageVersion)
  && (v.contributions === null || isContrib(v.contributions)) && (v.manifestExtensions === null || count(v.manifestExtensions))
const isNamed = (v: unknown): v is OverviewNamedItem => isPlainRecord(v) && hasExactKeys(v, ['name', 'scope']) && str(v.name) && scopeOk(v.scope)
const isContext = (v: unknown): v is OverviewContextFile => isPlainRecord(v) && hasExactKeys(v, ['path', 'scope', 'bytes']) && str(v.path) && scopeOk(v.scope) && count(v.bytes)

export function isNativeResourcesOverview(value: unknown): value is NativeResourcesOverview {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['workspacePath', 'packages', 'topLevel', 'contextFiles', 'errors'])) return false
  const top = value.topLevel
  const errors = value.errors
  return nstr(value.workspacePath) && arrayOf(value.packages, isPackage)
    && isPlainRecord(top) && hasExactKeys(top, ['skills', 'prompts', 'extensions', 'themes'])
    && arrayOf(top.skills, isNamed) && arrayOf(top.prompts, isNamed) && arrayOf(top.extensions, isNamed) && arrayOf(top.themes, isNamed)
    && arrayOf(value.contextFiles, isContext)
    && isPlainRecord(errors) && hasExactKeys(errors, ['packages', 'commands', 'topLevel', 'contextFiles'])
    && nstr(errors.packages) && nstr(errors.commands) && nstr(errors.topLevel) && nstr(errors.contextFiles)
}
