import { basename } from 'node:path'
import { ScopedSettingsService, type ScopedJsonSnapshot, type ScopedTextSnapshot } from '../config/settings-service.ts'
import { isPlainRecord } from '../../shared/ipc-contracts.ts'
import {
  HERDR_SETTINGS_PROVIDER,
  type HerdrConfigSnapshot,
  type HerdrDefinitionSummary,
  type HerdrJsonObject,
  type HerdrSettingsMutationResult,
  type HerdrSettingsProvider,
  type HerdrSettingsReadRequest,
  type HerdrSettingsScope,
  type HerdrSettingsSnapshot,
  type HerdrSettingsUpdateRequest,
  type HerdrSettingsValidationIssue,
} from '../../shared/herdr-settings.ts'

const CONFIG_PATH = 'herdr-agents/config.json'
const DEFINITION_DIRECTORY: Record<HerdrSettingsScope, string> = {
  user: 'agents',
  project: '.pi/agents',
}
const TASK_CATEGORIES = ['coding', 'review', 'recon', 'qa', 'architecture', 'docs'] as const
const MODEL_KEYS = ['default', 'agents', 'tasks', 'tasksMeta'] as const
const NATIVE_AGENT_FIELDS = [
  'name', 'description', 'model', 'tools', 'system-prompt', 'skills', 'skill', 'thinking',
  'deny-tools', 'spawning', 'persistent', 'auto-exit', 'interactive', 'session-mode', 'cwd',
  'disable-model-invocation',
] as const
const DEFINITION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function issue(path: string, message: string, severity: 'warning' | 'error' = 'error'): HerdrSettingsValidationIssue {
  return { path, message, severity }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function warnUnknownKeys(
  object: Record<string, unknown>,
  known: readonly string[],
  path: string,
  issues: HerdrSettingsValidationIssue[],
): void {
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) issues.push(issue(`${path}.${key}`, 'This key is not recognized by the installed Herdr version and will be preserved.', 'warning'))
  }
}

/** Validate the current pi-herdr-agents config shape without inserting native defaults. */
export function validateHerdrConfig(value: unknown, exists = true): readonly HerdrSettingsValidationIssue[] {
  const issues: HerdrSettingsValidationIssue[] = []
  if (!isPlainRecord(value)) return [issue('$', 'The Herdr configuration root must be an object.')]

  if (!Object.hasOwn(value, 'status')) {
    if (exists) issues.push(issue('status', 'The installed status parser requires a status object with enabled when a config file exists.', 'warning'))
  } else if (!isPlainRecord(value.status)) {
    issues.push(issue('status', 'Must be an object.'))
  } else {
    warnUnknownKeys(value.status, ['enabled'], 'status', issues)
    if (typeof value.status.enabled !== 'boolean') issues.push(issue('status.enabled', 'Must be a boolean.'))
  }

  if (value.models != null) {
    if (!isPlainRecord(value.models)) {
      issues.push(issue('models', 'Must be an object.'))
    } else {
      warnUnknownKeys(value.models, MODEL_KEYS, 'models', issues)
      if (value.models.default != null) {
        if (!isNonEmptyString(value.models.default)) issues.push(issue('models.default', 'Must be a non-empty model reference.'))
        else if (value.models.default.trim().toLowerCase().startsWith('task:')) issues.push(issue('models.default', 'task: references are only accepted as subagent tool model arguments.'))
      }
      if (value.models.agents != null) {
        if (!isPlainRecord(value.models.agents)) {
          issues.push(issue('models.agents', 'Must be an object keyed by agent name.'))
        } else {
          for (const [agent, model] of Object.entries(value.models.agents)) {
            if (!isNonEmptyString(model)) issues.push(issue(`models.agents.${agent}`, 'Must be a non-empty model reference.'))
            else if (model.trim().toLowerCase().startsWith('task:')) issues.push(issue(`models.agents.${agent}`, 'task: references are only accepted as subagent tool model arguments.'))
          }
        }
      }
      if (value.models.tasks != null) {
        if (!isPlainRecord(value.models.tasks)) {
          issues.push(issue('models.tasks', 'Must be an object of task-category candidate lists.'))
        } else {
          warnUnknownKeys(value.models.tasks, TASK_CATEGORIES, 'models.tasks', issues)
          for (const category of TASK_CATEGORIES) {
            if (!Object.hasOwn(value.models.tasks, category)) continue
            const candidates = value.models.tasks[category]
            if (!Array.isArray(candidates) || candidates.length === 0 || !candidates.every(isNonEmptyString)) {
              issues.push(issue(`models.tasks.${category}`, 'Must be a non-empty list of non-empty model references.'))
            } else if (new Set(candidates.map((candidate) => candidate.trim())).size !== candidates.length) {
              issues.push(issue(`models.tasks.${category}`, 'Candidate references must be unique within a category.'))
            }
          }
        }
      }
      if (value.models.tasksMeta != null) {
        const meta = value.models.tasksMeta
        if (!isPlainRecord(meta)) {
          issues.push(issue('models.tasksMeta', 'Must be an object.'))
        } else {
          warnUnknownKeys(meta, ['generatedAt', 'method'], 'models.tasksMeta', issues)
          const generatedAt = meta.generatedAt
          if (typeof generatedAt !== 'string'
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(generatedAt)
            || Number.isNaN(Date.parse(generatedAt))) {
            issues.push(issue('models.tasksMeta.generatedAt', 'Must be a valid ISO-8601 timestamp.'))
          }
          if (meta.method !== 'research' && meta.method !== 'registry-only') {
            issues.push(issue('models.tasksMeta.method', 'Must be research or registry-only.'))
          }
        }
      }
    }
  }

  if (Object.hasOwn(value, 'roles')) {
    if (!isPlainRecord(value.roles)) {
      issues.push(issue('roles', 'Must be an object.'))
    } else {
      warnUnknownKeys(value.roles, ['bundled'], 'roles', issues)
      if (Object.hasOwn(value.roles, 'bundled') && typeof value.roles.bundled !== 'boolean') {
        issues.push(issue('roles.bundled', 'Must be a boolean.'))
      }
    }
  }

  if (Object.hasOwn(value, 'persistent')) {
    if (!isPlainRecord(value.persistent)) {
      issues.push(issue('persistent', 'Must be an object.'))
    } else {
      warnUnknownKeys(value.persistent, ['maxAgents'], 'persistent', issues)
      if (Object.hasOwn(value.persistent, 'maxAgents')
        && (!Number.isFinite(value.persistent.maxAgents)
          || !Number.isInteger(value.persistent.maxAgents)
          || (value.persistent.maxAgents as number) < 1)) {
        issues.push(issue('persistent.maxAgents', 'Must be a positive integer.'))
      }
    }
  }

  if (Object.hasOwn(value, 'supervision')) {
    if (!isPlainRecord(value.supervision)) {
      issues.push(issue('supervision', 'Must be an object.'))
    } else {
      warnUnknownKeys(value.supervision, ['forcePolling', 'hangWarningMinutes'], 'supervision', issues)
      if (Object.hasOwn(value.supervision, 'forcePolling') && typeof value.supervision.forcePolling !== 'boolean') {
        issues.push(issue('supervision.forcePolling', 'Must be a boolean.'))
      }
      if (Object.hasOwn(value.supervision, 'hangWarningMinutes')
        && (!Number.isFinite(value.supervision.hangWarningMinutes)
          || !Number.isInteger(value.supervision.hangWarningMinutes)
          || (value.supervision.hangWarningMinutes as number) < 0)) {
        issues.push(issue('supervision.hangWarningMinutes', 'Must be a non-negative integer.'))
      }
    }
  }

  if (Object.hasOwn(value, 'panes')) {
    if (!isPlainRecord(value.panes)) {
      issues.push(issue('panes', 'Must be an object.'))
    } else {
      warnUnknownKeys(value.panes, ['mode', 'direction', 'maxPerTab'], 'panes', issues)
      if (Object.hasOwn(value.panes, 'mode') && !['grouped', 'tab', 'split'].includes(value.panes.mode as string)) {
        issues.push(issue('panes.mode', 'Must be grouped, tab, or split.'))
      }
      if (Object.hasOwn(value.panes, 'direction') && !['right', 'down'].includes(value.panes.direction as string)) {
        issues.push(issue('panes.direction', 'Must be right or down.'))
      }
      if (Object.hasOwn(value.panes, 'maxPerTab')
        && (!Number.isSafeInteger(value.panes.maxPerTab) || (value.panes.maxPerTab as number) < 1)) {
        issues.push(issue('panes.maxPerTab', 'Must be a positive safe integer.'))
      }
    }
  }
  return issues
}

export function validateHerdrDefinition(frontmatter: Readonly<Record<string, string>>): readonly HerdrSettingsValidationIssue[] {
  const issues: HerdrSettingsValidationIssue[] = []
  if (frontmatter.cli?.trim()) {
    issues.push(issue('cli', 'External CLI role definitions are unsupported by the installed Pi-only Herdr extension.'))
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!NATIVE_AGENT_FIELDS.includes(key as (typeof NATIVE_AGENT_FIELDS)[number])) continue
    if (/\r|\n/.test(value)) issues.push(issue(key, 'Must be a single-line scalar.'))
  }
  for (const field of ['tools', 'deny-tools'] as const) {
    const value = frontmatter[field]?.trim()
    if (value === undefined) continue
    if (!value.trim() || /^[\[{|>]/.test(value.trim()) || value.includes('#') || value.includes('"') || value.includes("'")
      || value.split(',').some((item) => !item.trim())) {
      issues.push(issue(field, 'Must be a non-empty comma-separated scalar without YAML containers, comments, or quotes.'))
    }
  }
  for (const field of ['spawning', 'persistent'] as const) {
    const value = frontmatter[field]?.trim()
    if (value !== undefined && value !== 'true' && value !== 'false') issues.push(issue(field, 'Must be true or false.'))
  }
  for (const field of ['auto-exit', 'interactive', 'disable-model-invocation'] as const) {
    const value = frontmatter[field]?.trim()
    if (value !== undefined && value !== 'true' && value !== 'false') issues.push(issue(field, 'Must be true or false.'))
  }
  if (frontmatter['system-prompt'] !== undefined && !['replace', 'append'].includes(frontmatter['system-prompt'].trim())) {
    issues.push(issue('system-prompt', 'Must be replace or append.'))
  }
  if (frontmatter['session-mode'] !== undefined
    && !['standalone', 'lineage-only', 'fork'].includes(frontmatter['session-mode'].trim())) {
    issues.push(issue('session-mode', 'Must be standalone, lineage-only, or fork.'))
  }
  if (frontmatter.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(frontmatter.thinking.trim())) {
    issues.push(issue('thinking', 'Must be a supported Pi thinking level.'))
  }
  for (const field of ['name', 'description', 'model', 'skills', 'skill', 'cwd'] as const) {
    const value = frontmatter[field]?.trim()
    if (value !== undefined && !value.trim()) issues.push(issue(field, 'Must not be empty when present.'))
  }
  return issues
}

function definitionName(path: string, frontmatter: Readonly<Record<string, string>>): string {
  return frontmatter.name?.trim() || basename(path, '.md')
}

function definitionSummary(scope: HerdrSettingsScope, file: ScopedTextSnapshot): HerdrDefinitionSummary {
  const allValidation = validateHerdrDefinition(file.frontmatter)
  const metadata: Record<string, string> = Object.create(null) as Record<string, string>
  for (const key of NATIVE_AGENT_FIELDS) {
    if (Object.hasOwn(file.frontmatter, key)) metadata[key] = file.frontmatter[key].trim()
  }
  return {
    name: definitionName(file.path, file.frontmatter),
    scope,
    revision: file.revision,
    exists: file.exists,
    hasFrontmatter: file.hasFrontmatter,
    metadata,
    validation: file.hasFrontmatter ? allValidation : [issue('$', 'Definition must start with frontmatter.')],
  }
}

function configSnapshot(file: ScopedJsonSnapshot): HerdrConfigSnapshot {
  const document = file.document as HerdrJsonObject
  const issues = validateHerdrConfig(document, file.exists)
  return {
    provider: HERDR_SETTINGS_PROVIDER,
    target: 'config',
    scope: 'user',
    revision: file.revision,
    exists: file.exists,
    settings: document,
    validation: issues,
  }
}

function definitionPath(scope: HerdrSettingsScope, name: string): string {
  if (!DEFINITION_NAME.test(name)) throw new TypeError('Herdr definition name is invalid.')
  return `${DEFINITION_DIRECTORY[scope]}/${name}.md`
}

function hasErrors(issues: readonly HerdrSettingsValidationIssue[]): boolean {
  return issues.some((entry) => entry.severity === 'error')
}

function isNativeRemovalPath(path: string): boolean {
  if ([
    'status.enabled', 'models.default', 'models.agents', 'models.tasks', 'models.tasksMeta',
    'roles.bundled', 'persistent.maxAgents', 'supervision.forcePolling',
    'supervision.hangWarningMinutes', 'panes.mode', 'panes.direction', 'panes.maxPerTab',
  ].includes(path)) return true
  if (/^models\.agents\.[A-Za-z0-9._-]+$/.test(path)) return true
  const taskPath = path.match(/^models\.tasks\.([A-Za-z][A-Za-z0-9_-]*)$/)
  return taskPath !== null && TASK_CATEGORIES.includes(taskPath[1] as (typeof TASK_CATEGORIES)[number])
}

export class HerdrSettingsStore {
  constructor(private readonly files: ScopedSettingsService) {}

  read(request: HerdrSettingsReadRequest): HerdrSettingsSnapshot {
    if (request.provider !== HERDR_SETTINGS_PROVIDER) throw new TypeError('Herdr provider is unsupported.')
    if (request.target === 'config') {
      return configSnapshot(this.files.readJson('user', CONFIG_PATH))
    }
    if (request.target === 'definitions') {
      const directory = DEFINITION_DIRECTORY[request.scope]
      const definitions = this.files.listMarkdown(request.scope, directory).map((file) => definitionSummary(request.scope, file))
      return { provider: HERDR_SETTINGS_PROVIDER, target: 'definitions', scope: request.scope, definitions }
    }
    const file = this.files.readFrontmatter(request.scope, definitionPath(request.scope, request.name))
    return { provider: HERDR_SETTINGS_PROVIDER, target: 'definition', scope: request.scope, definition: definitionSummary(request.scope, file) }
  }

  update(request: HerdrSettingsUpdateRequest): HerdrSettingsMutationResult {
    if (request.provider !== HERDR_SETTINGS_PROVIDER) throw new TypeError('Herdr provider is unsupported.')
    if (request.target === 'config') {
      if (request.removePaths.some((path) => !isNativeRemovalPath(path))) {
        throw new TypeError('Only native Herdr settings fields may be removed.')
      }
      const result = this.files.updateJson(
        'user',
        CONFIG_PATH,
        request.expectedRevision,
        request.patch as Record<string, unknown>,
        request.removePaths,
        (candidate) => {
          const issues = validateHerdrConfig(candidate, true)
          if (hasErrors(issues)) throw new TypeError('Herdr settings contain invalid values.')
        },
      )
      return { outcome: result.outcome, snapshot: configSnapshot(result.snapshot) }
    }
    if (Object.keys(request.metadata).length === 0) throw new TypeError('Herdr definition update contains no fields.')
    const path = definitionPath(request.scope, request.name)
    const result = this.files.updateFrontmatter(
      request.scope,
      path,
      request.expectedRevision,
      request.metadata,
      (candidate) => {
        const issues = validateHerdrDefinition(candidate)
        if (hasErrors(issues)) throw new TypeError('Herdr definition contains invalid metadata.')
      },
    )
    return {
      outcome: result.outcome,
      snapshot: {
        provider: HERDR_SETTINGS_PROVIDER,
        target: 'definition',
        scope: request.scope,
        definition: definitionSummary(request.scope, result.snapshot),
      },
    }
  }
}
