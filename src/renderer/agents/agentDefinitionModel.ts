import type { AgentDefinition, AgentDefinitionListScope, AgentDefinitionProvider, AgentDefinitionScope } from '../../shared/agent-definitions.ts'

export const tintinwebFields = ['display_name', 'color', 'description', 'tools', 'disallowed_tools', 'extensions', 'inherit_extensions', 'exclude_extensions', 'skills', 'inherit_skills', 'model', 'thinking', 'max_turns', 'persist_session', 'output_transcript', 'session_dir', 'allowed_subagents', 'prompt_mode', 'inherit_context', 'run_in_background', 'isolated', 'memory', 'isolation', 'enabled'] as const
export const nicobailonFields = ['package', 'description', 'advertise', 'alias', 'aliases', 'tools', 'excludeTools', 'allowNestedSubagents', 'allowedAgents', 'model', 'fast', 'thinking', 'systemPromptMode', 'inheritProjectContext', 'inheritGlobalContext', 'inheritSkills', 'defaultContext', 'async', 'timeoutMs', 'toolTimeoutMs', 'acceptance', 'acceptanceRole', 'skill', 'skills', 'skillPath', 'extensions', 'subagentOnlyExtensions', 'mutationTools', 'machine', 'output', 'outputMode', 'outputSchema', 'defaultReads', 'defaultProgress', 'interactive', 'maxSubagentDepth', 'toolBudget', 'permission', 'permissions', 'memory', 'runner'] as const
export const herdrFields = ['description', 'model', 'tools', 'system-prompt', 'skills', 'skill', 'thinking', 'deny-tools', 'spawning', 'persistent', 'auto-exit', 'interactive', 'session-mode', 'cwd', 'disable-model-invocation'] as const
export type AgentDefinitionKind = NonNullable<AgentDefinition['kind']>
export const boolFields = new Set(['enabled', 'persist_session', 'output_transcript', 'inherit_context', 'run_in_background', 'isolated', 'advertise', 'allowNestedSubagents', 'fast', 'inheritProjectContext', 'inheritGlobalContext', 'inheritSkills', 'async', 'defaultProgress', 'interactive', 'spawning', 'persistent', 'auto-exit', 'disable-model-invocation'])
export const numericFields = new Set(['max_turns', 'timeoutMs', 'toolTimeoutMs', 'maxSubagentDepth'])
export const stringOrFalseFields = new Set(['package', 'thinking'])
export const herdrKinds: readonly AgentDefinitionKind[] = ['agent', 'task', 'role']
export const scopes: readonly AgentDefinitionListScope[] = ['all', 'user', 'project', 'workspace', 'bundled']
export const scopeLabels: Record<AgentDefinitionListScope, string> = { all: 'All scopes', user: 'User', project: 'Project', workspace: 'Workspace', bundled: 'Bundled' }
export const providerLabels: Record<AgentDefinitionProvider, string> = { tintinweb: 'Tintinweb agents', herdr: 'Herdr definitions', nicobailon: 'Nicobailon subagents' }
export const scopeLabelsForDefinition: Record<AgentDefinitionScope, string> = { user: 'User', project: 'Project', workspace: 'Workspace', bundled: 'Bundled' }

export type Editor = { mode: 'create' | 'edit'; id?: string; provider: AgentDefinitionProvider; scope: 'user' | 'project'; kind?: AgentDefinitionKind; revision: number; name: string; fields: Record<string, unknown>; prompt: string; clearFields: Set<string>; source?: AgentDefinition }
export function providerFor(item: AgentDefinition): AgentDefinitionProvider { return item.provider ?? 'tintinweb' }
export function fieldsFor(provider: AgentDefinitionProvider, kind?: AgentDefinitionKind): readonly string[] {
  if (provider === 'herdr') return kind === 'task' ? [] : herdrFields
  if (provider === 'nicobailon') return nicobailonFields
  return ['name', ...tintinwebFields]
}
export function nameIssue(provider: AgentDefinitionProvider, name: string, kind?: AgentDefinitionKind): string | null {
  if (!name.trim()) return 'Name is required.'
  if (name.includes(':')) return 'The selected native provider reserves colons in names.'
  if (provider === 'herdr') return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? null : 'Herdr names must use 1–64 letters, numbers, dots, underscores or hyphens.'
  if (name.length > 256) return 'Names must be no longer than 256 characters.'
  return null
}
export function displayValue(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value) ?? '' }
export function parseEditedValue(key: string, text: string): unknown {
  if (boolFields.has(key)) return text === 'true'
  if (numericFields.has(key)) return text.trim() === '' ? undefined : Number(text)
  try { return JSON.parse(text) as unknown } catch { return text }
}
export function enabledLabel(item: AgentDefinition): string {
  const provider = providerFor(item)
  if (provider === 'herdr') return item.kind === 'task' ? 'Enabled for app task dispatch' : 'Model invocation allowed'
  if (provider === 'nicobailon') return 'Enabled via native settings override'
  return 'Enabled in Tintinweb agent dispatch'
}

export const boolHelp: Record<string, string> = {
  enabled: 'Allow this agent to be dispatched.',
  spawning: 'Allow this agent to spawn further agents.',
  persistent: 'Keep the session alive between uses.',
  'auto-exit': 'Exit automatically when the task completes.',
  interactive: 'Run with an interactive terminal.',
  'disable-model-invocation': 'Hide from the model; only explicit use can invoke it.',
  persist_session: 'Save the agent session to disk.',
  output_transcript: 'Write a transcript of the run.',
  inherit_context: "Start with the parent's conversation context.",
  run_in_background: 'Run without blocking the parent.',
  isolated: 'Run without inherited extensions and skills.',
  advertise: 'Advertise this agent to the model.',
  allowNestedSubagents: 'Allow nested subagents.',
  fast: 'Prefer the fast mode of the model.',
  inheritProjectContext: 'Inherit project context files.',
  inheritGlobalContext: 'Inherit global context files.',
  inheritSkills: 'Inherit skills from the parent.',
  async: 'Run asynchronously.',
  defaultProgress: 'Report progress by default.',
}
export const toolListKeys = ['tools', 'disallowed_tools', 'excludeTools', 'deny-tools'] as const
export const toolListLabels: Record<string, string> = { tools: 'Tools', disallowed_tools: 'Disallowed tools', excludeTools: 'Excluded tools', 'deny-tools': 'Denied tools' }
export const promotedKeys = new Set<string>(['name', 'description', 'model', 'thinking', ...toolListKeys, ...boolFields])

export function isReadOnlyDefinition(item: AgentDefinition): boolean { return item.editable === false || item.scope === 'bundled' || item.scope === 'workspace' }
export function snapshotOf(editor: Editor): string { return JSON.stringify({ n: editor.name, f: editor.fields, p: editor.prompt, c: [...editor.clearFields].sort() }) }
