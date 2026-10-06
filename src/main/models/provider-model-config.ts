import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isPlainRecord } from '../../shared/ipc-contracts.ts'
import { isProviderModelConfigRefreshRequest } from '../../shared/providers.ts'
import type {
  ProviderModelConfigCreateRequest,
  ProviderModelConfigDeleteRequest,
  ProviderModelConfigDiagnostic,
  ProviderModelConfigEntry,
  ProviderModelConfigMutationResponse,
  ProviderModelConfigReadRequest,
  ProviderModelConfigReadResponse,
  ProviderModelConfigRefreshResponse,
  ProviderModelConfigState,
  ProviderModelConfigUpdateRequest,
} from '../../shared/providers.ts'
import type { ModelService } from './model-service.ts'

const MAX_MODELS_JSON_BYTES = 1024 * 1024
const REDACTED = '[REDACTED]'
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RESERVED_PROVIDER_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const MODEL_FIELDS = [
  'id', 'name', 'api', 'baseUrl', 'reasoning', 'thinkingLevelMap', 'input', 'inputLimits', 'cost',
  'promptCache', 'contextWindow', 'maxTokens', 'samplingParams', 'headers', 'compat',
] as const
const OVERRIDE_FIELDS = [
  'name', 'reasoning', 'thinkingLevelMap', 'input', 'inputLimits', 'cost', 'promptCache', 'contextWindow',
  'maxTokens', 'samplingParams', 'headers', 'compat',
] as const
const COMPAT_BOOLEAN_FIELDS = [
  'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
  'supportsFinishReason', 'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages', 'supportsOpenAIGrammarTools', 'supportsStrictMode',
  'sendSessionAffinityHeaders', 'supportsLongCacheRetention', 'supportsMaxOutputTokens',
  'supportsEagerToolInputStreaming', 'supportsCacheControlOnTools', 'supportsTemperature', 'forceAdaptiveThinking',
  'allowEmptySignature', 'supportsStrictTools', 'supportsMidConvoEffort',
] as const
const THINKING_FORMATS = new Set([
  'openai', 'openrouter', 'together', 'baseten', 'deepseek', 'zai', 'qwen', 'chat-template',
  'qwen-chat-template', 'string-thinking', 'ant-ling',
])
const SESSION_AFFINITY_FORMATS = new Set(['openai', 'openai-nosession', 'openrouter'])

type ParsedModelsFile = {
  readonly contents: string | undefined
  readonly revision: string
  readonly exists: boolean
  readonly document: Record<string, unknown>
  readonly providers: Record<string, unknown> | undefined
  readonly diagnostics: readonly ProviderModelConfigDiagnostic[]
}

export interface ProviderModelConfigServiceOptions {
  /** Pi's canonical user agent directory; native provider config is agentDir/models.json. */
  readonly agentDir: string
  readonly models: ModelService
  /** Must reflect current runtime trust/authorization. Mutations are denied when absent or false. */
  readonly authorizeMutation: () => boolean
}

interface FileLock {
  release(): void
}

function revision(contents: string | undefined): string {
  return createHash('sha256').update(contents === undefined ? '\0missing-models.json' : contents, 'utf8').digest('hex')
}

function nativeJsonc(contents: string): string {
  return contents
    .replace(/^\uFEFF/, '')
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ''))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ''))
}

function diagnostic(
  code: ProviderModelConfigDiagnostic['code'],
  message: string,
  path?: readonly string[],
): ProviderModelConfigDiagnostic {
  return { code, ...(path && path.length > 0 ? { path } : {}), message }
}

function parseDocument(contents: string | undefined): ParsedModelsFile {
  const currentRevision = revision(contents)
  if (contents === undefined) {
    return {
      contents,
      revision: currentRevision,
      exists: false,
      document: { providers: {} },
      providers: {},
      diagnostics: [],
    }
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_MODELS_JSON_BYTES) {
    return {
      contents,
      revision: currentRevision,
      exists: true,
      document: {},
      providers: undefined,
      diagnostics: [diagnostic('native-config-load-failed', 'Pi could not load the native models.json file.')],
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(nativeJsonc(contents))
  } catch {
    return {
      contents,
      revision: currentRevision,
      exists: true,
      document: {},
      providers: undefined,
      diagnostics: [diagnostic('native-config-parse-failed', 'Pi could not parse the native models.json file.')],
    }
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.providers)) {
    return {
      contents,
      revision: currentRevision,
      exists: true,
      document: isPlainRecord(parsed) ? parsed : {},
      providers: undefined,
      diagnostics: [diagnostic('native-config-schema-invalid', 'Pi rejected fields in the native models.json schema.')],
    }
  }
  return {
    contents,
    revision: currentRevision,
    exists: true,
    document: parsed,
    providers: parsed.providers,
    diagnostics: [],
  }
}

function safeRead(path: string): string | undefined {
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('The native models.json file cannot be safely read.')
  }
  try {
    const file = fstatSync(descriptor)
    if (!file.isFile() || file.size > MAX_MODELS_JSON_BYTES) {
      throw new Error('The native models.json file is invalid or too large.')
    }
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function failedRead(path: string): ParsedModelsFile {
  let exists = false
  try {
    const file = lstatSync(path)
    exists = file.isFile() || file.isSymbolicLink()
  } catch {
    // A missing file uses the native empty-config snapshot.
  }
  return {
    contents: undefined,
    revision: createHash('sha256').update(`unreadable:${resolve(path)}`, 'utf8').digest('hex'),
    exists,
    document: {},
    providers: undefined,
    diagnostics: [diagnostic('native-config-load-failed', 'Pi could not safely read the native models.json file.')],
  }
}

function readParsed(path: string): ParsedModelsFile {
  try {
    return parseDocument(safeRead(path))
  } catch {
    return failedRead(path)
  }
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!statSync(directory).isDirectory()) throw new Error('The Pi agent directory must resolve to a directory.')
}

async function acquireFileLock(path: string): Promise<FileLock | undefined> {
  const directory = `${path}.lockdir`
  const ownerPath = join(directory, 'owner')
  const token = randomUUID()
  const timeoutAt = Date.now() + 2500
  ensureDirectory(dirname(path))
  while (Date.now() < timeoutAt) {
    try {
      mkdirSync(directory, { mode: 0o700 })
      let descriptor: number | undefined
      let ownerCreated = false
      try {
        descriptor = openSync(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
        ownerCreated = true
        writeFileSync(descriptor, token, 'utf8')
        fsyncSync(descriptor)
      } catch (error) {
        if (descriptor !== undefined) {
          closeSync(descriptor)
          descriptor = undefined
        }
        if (ownerCreated) {
          try { unlinkSync(ownerPath) } catch { /* Remove only the owner file this acquisition created. */ }
        }
        try { rmdirSync(directory) } catch { /* The directory is no longer empty or no longer ours. */ }
        throw error
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
      }
      return {
        release: () => {
          try {
            const details = lstatSync(directory)
            if (!details.isDirectory() || details.isSymbolicLink()) return
            const owner = openSync(ownerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
            let current: string
            try { current = readFileSync(owner, 'utf8') } finally { closeSync(owner) }
            if (current !== token) return
            unlinkSync(ownerPath)
            rmdirSync(directory)
          } catch {
            // Do not release another process's lock or follow a replaced lock path.
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25))
    }
  }
  return undefined
}

function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true })
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  const clone = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) setOwn(clone, key, structuredClone(value))
  return clone
}

function cloneValue(value: unknown): unknown {
  return structuredClone(value)
}

function mergeRecord(current: Record<string, unknown>, patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = cloneRecord(current)
  for (const [key, value] of Object.entries(patch)) {
    const previous = result[key]
    setOwn(result, key, isPlainRecord(previous) && isPlainRecord(value)
      ? mergeRecord(previous, value)
      : cloneValue(value))
  }
  return result
}

function mergeModels(current: unknown, patch: readonly unknown[]): unknown[] {
  const models = Array.isArray(current) ? current.map(cloneValue) : []
  const patchIds = new Set<string>()
  for (const candidate of patch) {
    if (!isPlainRecord(candidate) || typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new TypeError('Native model updates require a non-empty stable model id.')
    }
    if (patchIds.has(candidate.id)) throw new TypeError('Native model updates cannot repeat a model id.')
    patchIds.add(candidate.id)
    const matching = models.flatMap((model, index) => isPlainRecord(model) && model.id === candidate.id ? [index] : [])
    if (matching.length > 1) throw new TypeError('Existing native models contain duplicate ids and cannot be updated safely.')
    const index = matching[0] ?? -1
    if (index < 0) {
      models.push(cloneValue(candidate))
    } else {
      const previous = models[index]
      models[index] = isPlainRecord(previous) ? mergeRecord(previous, candidate) : cloneValue(candidate)
    }
  }
  return models
}

function mergeProvider(current: Record<string, unknown>, patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = cloneRecord(current)
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'models' && Array.isArray(value)) {
      setOwn(result, key, mergeModels(result[key], value))
      continue
    }
    const previous = result[key]
    setOwn(result, key, isPlainRecord(previous) && isPlainRecord(value)
      ? mergeRecord(previous, value)
      : cloneValue(value))
  }
  return result
}

function removeObjectPath(root: Record<string, unknown>, path: readonly string[]): void {
  let parent: Record<string, unknown> = root
  let index = 0
  while (index < path.length - 1) {
    const part = path[index]!
    const child = parent[part]
    if (part === 'models' && Array.isArray(child)) {
      const modelId = path[index + 1]
      if (modelId === undefined || index + 1 === path.length - 1) return
      const matches = child.filter((model) => isPlainRecord(model) && model.id === modelId)
      if (matches.length !== 1) return
      parent = matches[0] as Record<string, unknown>
      index += 2
      continue
    }
    if (!isPlainRecord(child)) return
    parent = child
    index++
  }
  delete parent[path[path.length - 1]!]
}

function safeFields(
  source: unknown,
  fields: readonly string[],
  isExpectedValue: (value: unknown) => boolean,
): Record<string, unknown> {
  const target = Object.create(null) as Record<string, unknown>
  if (!isPlainRecord(source)) return target
  for (const field of fields) {
    if (Object.hasOwn(source, field) && isExpectedValue(source[field])) {
      setOwn(target, field, cloneValue(source[field]))
    }
  }
  return target
}

function safeNestedFields(
  source: unknown,
  fields: readonly string[],
  isExpectedValue: (value: unknown) => boolean,
): Record<string, unknown> {
  return safeFields(source, fields, isExpectedValue)
}

function safeStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value.slice() : undefined
}

function safeDtoKey(key: string): boolean {
  return key.length > 0 && key.length <= 1024 && !['__proto__', 'prototype', 'constructor'].includes(key)
}

function redactedHeaders(source: unknown, path: string, secretPaths: string[]): unknown {
  if (!isPlainRecord(source)) return undefined
  const headers = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!safeDtoKey(key)) continue
    setOwn(headers, key, REDACTED)
    secretPaths.push(`${path}.${key}`)
  }
  return headers
}

function safeCompat(source: unknown, path: string, secretPaths: string[]): unknown {
  if (!isPlainRecord(source)) return undefined
  const compat = safeFields(source, COMPAT_BOOLEAN_FIELDS, (value) => typeof value === 'boolean')
  const scalarFields = safeFields(source, ['maxTokensField'], (value) => value === 'max_completion_tokens' || value === 'max_tokens')
  for (const [key, value] of Object.entries(scalarFields)) setOwn(compat, key, value)
  const thinkingFormat = safeFields(source, ['thinkingFormat'], (value) => typeof value === 'string' && THINKING_FORMATS.has(value))
  const cacheFormat = safeFields(source, ['cacheControlFormat'], (value) => value === 'anthropic')
  const affinityFormat = safeFields(source, ['sessionAffinityFormat'], (value) => typeof value === 'string' && SESSION_AFFINITY_FORMATS.has(value))
  const priority = safeFields(source, ['vllmPriority'], (value) => typeof value === 'number' && Number.isFinite(value))
  for (const projected of [thinkingFormat, cacheFormat, affinityFormat, priority]) {
    for (const [key, value] of Object.entries(projected)) setOwn(compat, key, value)
  }
  for (const field of ['chatTemplateKwargs', 'chatTemplateArgs']) {
    if (Object.hasOwn(source, field)) {
      setOwn(compat, field, REDACTED)
      secretPaths.push(`${path}.${field}`)
    }
  }
  if (isPlainRecord(source.openRouterRouting)) {
    const routing = safeFields(source.openRouterRouting,
      ['allow_fallbacks', 'require_parameters', 'zdr', 'enforce_distillable_text'],
      (value) => typeof value === 'boolean')
    const dataCollection = source.openRouterRouting.data_collection
    if (dataCollection === 'deny' || dataCollection === 'allow') setOwn(routing, 'data_collection', dataCollection)
    for (const field of ['order', 'only', 'ignore', 'quantizations']) {
      const values = safeStringArray(source.openRouterRouting[field])
      if (values) setOwn(routing, field, values)
    }
    if (typeof source.openRouterRouting.sort === 'string') setOwn(routing, 'sort', source.openRouterRouting.sort)
    else if (isPlainRecord(source.openRouterRouting.sort)) {
      setOwn(routing, 'sort', safeFields(source.openRouterRouting.sort, ['by', 'partition'], (value) =>
        typeof value === 'string' || value === null))
    }
    if (isPlainRecord(source.openRouterRouting.max_price)) {
      setOwn(routing, 'max_price', safeFields(source.openRouterRouting.max_price,
        ['prompt', 'completion', 'image', 'audio', 'request'],
        (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))))
    }
    for (const field of ['preferred_min_throughput', 'preferred_max_latency']) {
      const value = source.openRouterRouting[field]
      if (typeof value === 'number' && Number.isFinite(value)) setOwn(routing, field, value)
      else if (isPlainRecord(value)) setOwn(routing, field, safeFields(value, ['p50', 'p75', 'p90', 'p99'],
        (entry) => typeof entry === 'number' && Number.isFinite(entry)))
    }
    setOwn(compat, 'openRouterRouting', routing)
  } else if (Object.hasOwn(source, 'openRouterRouting')) {
    setOwn(compat, 'openRouterRouting', REDACTED)
    secretPaths.push(`${path}.openRouterRouting`)
  }
  if (isPlainRecord(source.vercelGatewayRouting)) {
    const routing = Object.create(null) as Record<string, unknown>
    for (const field of ['only', 'order']) {
      const values = safeStringArray(source.vercelGatewayRouting[field])
      if (values) setOwn(routing, field, values)
    }
    setOwn(compat, 'vercelGatewayRouting', routing)
  } else if (Object.hasOwn(source, 'vercelGatewayRouting')) {
    setOwn(compat, 'vercelGatewayRouting', REDACTED)
    secretPaths.push(`${path}.vercelGatewayRouting`)
  }
  if (Array.isArray(source.allowedFallbackModels)) {
    setOwn(compat, 'allowedFallbackModels', REDACTED)
    secretPaths.push(`${path}.allowedFallbackModels`)
  } else if (Object.hasOwn(source, 'allowedFallbackModels')) {
    setOwn(compat, 'allowedFallbackModels', REDACTED)
    secretPaths.push(`${path}.allowedFallbackModels`)
  }
  return compat
}

function safeInputLimits(source: unknown): unknown {
  if (!isPlainRecord(source)) return undefined
  const isPositiveInteger = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 1
  const limits = safeFields(source, ['maxRequestBytes'], isPositiveInteger)
  if (isPlainRecord(source.images)) {
    const images = safeFields(source.images, ['maxPerMessage', 'maxPerRequest'], isPositiveInteger)
    if (isPlainRecord(source.images.resize)) {
      setOwn(images, 'resize', safeFields(source.images.resize,
        ['maxWidth', 'maxHeight', 'maxBytes', 'jpegQuality'], isPositiveInteger))
    }
    setOwn(limits, 'images', images)
  }
  return limits
}

function safeCost(source: unknown): unknown {
  if (!isPlainRecord(source)) return undefined
  const isNumber = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value)
  const cost = safeFields(source, ['input', 'output', 'cacheRead', 'cacheWrite'], isNumber)
  if (Array.isArray(source.tiers)) {
    setOwn(cost, 'tiers', source.tiers.map((tier) => isPlainRecord(tier)
      ? safeFields(tier, ['inputTokensAbove', 'input', 'output', 'cacheRead', 'cacheWrite'], isNumber)
      : undefined).filter((tier) => tier !== undefined))
  }
  return cost
}

function safeModelFields(
  source: unknown,
  fields: readonly string[],
  path: string,
  secretPaths: string[],
): Record<string, unknown> {
  const primitiveFields = fields.filter((field) => ['id', 'name', 'api'].includes(field))
  const model = safeFields(source, primitiveFields, (value) => typeof value === 'string' && value.length > 0)
  for (const [field, predicate] of [
    ['reasoning', (value: unknown) => typeof value === 'boolean'],
    ['contextWindow', (value: unknown) => typeof value === 'number' && Number.isFinite(value)],
    ['maxTokens', (value: unknown) => typeof value === 'number' && Number.isFinite(value)],
  ] as const) {
    for (const [key, value] of Object.entries(safeFields(source, [field], predicate))) setOwn(model, key, value)
  }
  if (!isPlainRecord(source)) return model
  const input = safeStringArray(source.input)
  if (input && input.every((value) => value === 'text' || value === 'image')) setOwn(model, 'input', input)
  if (Object.hasOwn(source, 'baseUrl')) {
    setOwn(model, 'baseUrl', REDACTED)
    secretPaths.push(`${path}.baseUrl`)
  }
  if (Object.hasOwn(source, 'headers')) {
    const headers = redactedHeaders(source.headers, `${path}.headers`, secretPaths)
    setOwn(model, 'headers', headers ?? REDACTED)
    if (headers === undefined) secretPaths.push(`${path}.headers`)
  }
  if (Object.hasOwn(source, 'samplingParams')) {
    setOwn(model, 'samplingParams', REDACTED)
    secretPaths.push(`${path}.samplingParams`)
  }
  if (Object.hasOwn(source, 'compat')) {
    const compat = safeCompat(source.compat, `${path}.compat`, secretPaths)
    setOwn(model, 'compat', compat ?? REDACTED)
    if (compat === undefined) secretPaths.push(`${path}.compat`)
  }
  if (isPlainRecord(source.inputLimits)) setOwn(model, 'inputLimits', safeInputLimits(source.inputLimits))
  if (isPlainRecord(source.cost)) setOwn(model, 'cost', safeCost(source.cost))
  if (isPlainRecord(source.promptCache)) setOwn(model, 'promptCache', safeNestedFields(source.promptCache, ['short', 'long'],
    (value) => typeof value === 'number' && Number.isFinite(value)))
  if (isPlainRecord(source.thinkingLevelMap)) setOwn(model, 'thinkingLevelMap', safeNestedFields(source.thinkingLevelMap,
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    (value) => typeof value === 'string' || value === null))
  return model
}

function safeDefinition(value: Record<string, unknown>): { readonly definition: Readonly<Record<string, unknown>>; readonly secretPaths: readonly string[] } {
  const secretPaths: string[] = []
  const definition = safeFields(value, ['name', 'api'], (field) => typeof field === 'string' && field.length > 0)
  for (const [key, field] of Object.entries(safeFields(value, ['oauth'], (entry) => entry === 'radius'))) {
    setOwn(definition, key, field)
  }
  for (const [key, field] of Object.entries(safeFields(value, ['authHeader'], (entry) => typeof entry === 'boolean'))) {
    setOwn(definition, key, field)
  }
  if (Object.hasOwn(value, 'apiKey')) {
    setOwn(definition, 'apiKey', REDACTED)
    secretPaths.push('apiKey')
  }
  if (Object.hasOwn(value, 'baseUrl')) {
    setOwn(definition, 'baseUrl', REDACTED)
    secretPaths.push('baseUrl')
  }
  if (Object.hasOwn(value, 'headers')) {
    const headers = redactedHeaders(value.headers, 'headers', secretPaths)
    setOwn(definition, 'headers', headers ?? REDACTED)
    if (headers === undefined) secretPaths.push('headers')
  }
  if (Object.hasOwn(value, 'compat')) {
    const compat = safeCompat(value.compat, 'compat', secretPaths)
    setOwn(definition, 'compat', compat ?? REDACTED)
    if (compat === undefined) secretPaths.push('compat')
  }
  if (Array.isArray(value.models)) {
    setOwn(definition, 'models', value.models.map((model, index) => safeModelFields(
      model,
      MODEL_FIELDS,
      `models[${index}]`,
      secretPaths,
    )))
  } else if (Object.hasOwn(value, 'models')) {
    setOwn(definition, 'models', REDACTED)
    secretPaths.push('models')
  }
  if (isPlainRecord(value.modelOverrides)) {
    const overrides = Object.create(null) as Record<string, unknown>
    for (const [modelId, override] of Object.entries(value.modelOverrides)) {
      if (!safeDtoKey(modelId)) continue
      setOwn(overrides, modelId, safeModelFields(override, OVERRIDE_FIELDS, `modelOverrides.${modelId}`, secretPaths))
    }
    setOwn(definition, 'modelOverrides', overrides)
  } else if (Object.hasOwn(value, 'modelOverrides')) {
    setOwn(definition, 'modelOverrides', REDACTED)
    secretPaths.push('modelOverrides')
  }
  secretPaths.sort((left, right) => left.localeCompare(right))
  return { definition, secretPaths }
}

function entryFor(providerId: string, value: unknown): ProviderModelConfigEntry | undefined {
  if (!isPlainRecord(value)) return undefined
  const { definition, secretPaths } = safeDefinition(value)
  return {
    providerId,
    definition,
    apiKeyConfigured: typeof value.apiKey === 'string' && value.apiKey.length > 0,
    baseUrlConfigured: typeof value.baseUrl === 'string' && value.baseUrl.length > 0,
    secretPaths,
  }
}

function validProviderId(providerId: string): boolean {
  return SAFE_PROVIDER_ID.test(providerId) && !RESERVED_PROVIDER_IDS.has(providerId)
}

function containsRedactedValue(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(REDACTED)
  if (Array.isArray(value)) return value.some(containsRedactedValue)
  return isPlainRecord(value) && Object.values(value).some(containsRedactedValue)
}

function mergeDiagnostics(
  ...sets: readonly (readonly ProviderModelConfigDiagnostic[])[]
): readonly ProviderModelConfigDiagnostic[] {
  const result: ProviderModelConfigDiagnostic[] = []
  for (const item of sets.flat()) {
    if (!result.some((existing) => existing.code === item.code && JSON.stringify(existing.path) === JSON.stringify(item.path))) {
      result.push(item)
    }
  }
  return result
}

function validDocument(parsed: ParsedModelsFile): boolean {
  return parsed.diagnostics.length === 0 && parsed.providers !== undefined
}

export class ProviderModelConfigService {
  private readonly modelsPath: string
  private readonly modelService: ModelService
  private readonly authorizeMutation: () => boolean

  constructor(options: ProviderModelConfigServiceOptions) {
    if (!isAbsolute(options.agentDir) || options.agentDir.includes('\0')) throw new TypeError('Pi agent directory must be an absolute path.')
    if (typeof options.authorizeMutation !== 'function') throw new TypeError('Provider model-config mutation authorization is required.')
    this.modelsPath = resolve(options.agentDir, 'models.json')
    this.modelService = options.models
    this.authorizeMutation = options.authorizeMutation
  }

  list(): ProviderModelConfigState {
    return this.makeState(readParsed(this.modelsPath))
  }

  read(request: ProviderModelConfigReadRequest): ProviderModelConfigReadResponse {
    const state = this.list()
    const entry = state.providers.find((provider) => provider.providerId === request.providerId) ?? null
    return { outcome: entry ? 'found' : 'not-found', state, entry }
  }

  create(request: ProviderModelConfigCreateRequest, authorizeCaller: () => boolean): Promise<ProviderModelConfigMutationResponse> {
    if (!validProviderId(request.providerId)) return Promise.resolve(this.invalidProviderId())
    if (containsRedactedValue(request.definition)) return Promise.resolve(this.invalidRedactedInput())
    return this.mutate(request.expectedRevision, authorizeCaller, async (parsed) => {
      const providers = this.requireProviders(parsed)
      if (Object.hasOwn(providers, request.providerId)) return { outcome: 'conflict' }
      const nextProviders = cloneRecord(providers)
      setOwn(nextProviders, request.providerId, cloneRecord(request.definition as Record<string, unknown>))
      return { outcome: 'write', document: { ...parsed.document, providers: nextProviders } }
    })
  }

  update(request: ProviderModelConfigUpdateRequest, authorizeCaller: () => boolean): Promise<ProviderModelConfigMutationResponse> {
    if (!validProviderId(request.providerId)) return Promise.resolve(this.invalidProviderId())
    if (containsRedactedValue(request.patch)) return Promise.resolve(this.invalidRedactedInput())
    return this.mutate(request.expectedRevision, authorizeCaller, async (parsed) => {
      const providers = this.requireProviders(parsed)
      const current = providers[request.providerId]
      if (!isPlainRecord(current)) return { outcome: 'not-found' }
      if ((request.removeModelIds ?? []).some((id) => Array.isArray(request.patch.models)
        && request.patch.models.some((model) => isPlainRecord(model) && model.id === id))) {
        return { outcome: 'invalid' }
      }
      const nextDefinition = mergeProvider(current, request.patch)
      for (const path of request.remove ?? []) removeObjectPath(nextDefinition, path)
      if (request.removeModelIds && Array.isArray(nextDefinition.models)) {
        const removed = new Set(request.removeModelIds)
        setOwn(nextDefinition, 'models', nextDefinition.models.filter((model) => !isPlainRecord(model) || !removed.has(String(model.id))))
      }
      const nextProviders = cloneRecord(providers)
      setOwn(nextProviders, request.providerId, nextDefinition)
      return { outcome: 'write', document: { ...parsed.document, providers: nextProviders } }
    })
  }

  delete(request: ProviderModelConfigDeleteRequest, authorizeCaller: () => boolean): Promise<ProviderModelConfigMutationResponse> {
    if (!validProviderId(request.providerId)) return Promise.resolve(this.invalidProviderId())
    return this.mutate(request.expectedRevision, authorizeCaller, async (parsed) => {
      const providers = this.requireProviders(parsed)
      if (!Object.hasOwn(providers, request.providerId)) return { outcome: 'not-found' }
      const nextProviders = cloneRecord(providers)
      delete nextProviders[request.providerId]
      return { outcome: 'write', document: { ...parsed.document, providers: nextProviders } }
    })
  }

  async refreshAvailability(
    request: unknown,
    authorizeCaller: () => boolean,
  ): Promise<ProviderModelConfigRefreshResponse> {
    if (!isProviderModelConfigRefreshRequest(request) || !this.isAuthorized() || !this.isCallerAuthorized(authorizeCaller)) {
      return { outcome: 'unauthorized', state: this.list() }
    }
    const diagnostics = await this.modelService.refreshNativeModelAvailability()
    if (!this.isAuthorized() || !this.isCallerAuthorized(authorizeCaller)) return { outcome: 'unauthorized', state: this.list() }
    const state = this.makeState(readParsed(this.modelsPath), diagnostics)
    return { outcome: state.diagnostics.length === 0 ? 'refreshed' : 'failed', state }
  }

  private async mutate(
    expectedRevision: string,
    authorizeCaller: () => boolean,
    transform: (parsed: ParsedModelsFile) => Promise<
      | { readonly outcome: 'write'; readonly document: Record<string, unknown> }
      | { readonly outcome: 'conflict' | 'not-found' | 'invalid' }
    >,
  ): Promise<ProviderModelConfigMutationResponse> {
    const beforeLock = readParsed(this.modelsPath)
    if (!this.isAuthorized() || !this.isCallerAuthorized(authorizeCaller)) return this.mutationResult('unauthorized', beforeLock)
    const lock = await acquireFileLock(this.modelsPath)
    if (!lock) return this.mutationResult('busy', readParsed(this.modelsPath))
    try {
      const parsed = readParsed(this.modelsPath)
      if (!this.isAuthorized() || !this.isCallerAuthorized(authorizeCaller)) return this.mutationResult('unauthorized', parsed)
      if (!validDocument(parsed)) return this.mutationResult('invalid', parsed, parsed.diagnostics)
      if (parsed.revision !== expectedRevision) return this.mutationResult('conflict', parsed)

      const operation = await transform(parsed)
      if (operation.outcome !== 'write') {
        return this.mutationResult(operation.outcome, parsed, operation.outcome === 'invalid'
          ? [diagnostic('native-provider-invalid', 'The native provider update is invalid.')]
          : [])
      }
      const prepared = this.modelService.prepareNativeModelConfiguration(operation.document)
      if (!prepared.prepared.valid) {
        const diagnostics = nativeDiagnostics(prepared.prepared.diagnostics)
        return this.mutationResult('invalid', parsed, diagnostics)
      }
      const serialized = `${JSON.stringify(operation.document, null, 2)}\n`
      if (Buffer.byteLength(serialized, 'utf8') > MAX_MODELS_JSON_BYTES) {
        return this.mutationResult('invalid', parsed, [diagnostic('native-config-load-failed', 'The native models.json file exceeds the size limit.')])
      }

      // The final authorization and revision checks run after the temporary file is synced and immediately before rename.
      try {
        const finalOutcome = this.atomicWrite(serialized, () => {
          if (!this.isAuthorized() || !this.isCallerAuthorized(authorizeCaller)) return 'unauthorized'
          const latest = readParsed(this.modelsPath)
          if (!validDocument(latest)) return 'invalid'
          if (latest.revision !== expectedRevision) return 'conflict'
          if (!this.isAuthorized() || !this.isCallerAuthorized(authorizeCaller)) return 'unauthorized'
          return undefined
        })
        if (finalOutcome) {
          const latest = readParsed(this.modelsPath)
          return this.mutationResult(finalOutcome, latest, finalOutcome === 'invalid' ? latest.diagnostics : [])
        }
      } catch {
        return this.mutationResult('invalid', readParsed(this.modelsPath), [
          diagnostic('native-config-load-failed', 'Pi could not safely write the native models.json file.'),
        ])
      }
      const publicationDiagnostics = this.modelService.publishPreparedNativeModelConfiguration(prepared)
      if (publicationDiagnostics.length > 0) {
        // Native prevalidation is credential-blind and publication is synchronous; unexpected failures fail closed
        // to the caller without overwriting the now-published file or any concurrent writer.
        return this.mutationResult('invalid', readParsed(this.modelsPath), publicationDiagnostics)
      }
      const state = this.makeState(readParsed(this.modelsPath), [], true)
      return { outcome: 'saved', state, diagnostics: state.diagnostics }
    } catch {
      return this.mutationResult('invalid', readParsed(this.modelsPath), [
        diagnostic('native-provider-invalid', 'Pi rejected the native provider configuration.'),
      ])
    } finally {
      lock.release()
    }
  }

  private makeState(
    parsed: ParsedModelsFile,
    additionalDiagnostics: readonly ProviderModelConfigDiagnostic[] = [],
    preparedConfigurationIsValid = false,
  ): ProviderModelConfigState {
    const providers: ProviderModelConfigEntry[] = []
    const idDiagnostics: ProviderModelConfigDiagnostic[] = []
    for (const providerId of Object.keys(parsed.providers ?? {}).sort((left, right) => left.localeCompare(right))) {
      if (!validProviderId(providerId)) {
        idDiagnostics.push(diagnostic('native-provider-id-invalid', 'Pi provider IDs must use letters, digits, dot, underscore, or hyphen.'))
        continue
      }
      const entry = entryFor(providerId, parsed.providers?.[providerId])
      if (entry) providers.push(entry)
    }
    let nativeDiagnostics: readonly ProviderModelConfigDiagnostic[] = []
    if (!preparedConfigurationIsValid && validDocument(parsed)) {
      nativeDiagnostics = this.modelService.validateNativeModelConfiguration(parsed.document)
    }
    return {
      scope: 'user',
      path: 'models.json',
      revision: parsed.revision,
      exists: parsed.exists,
      providers,
      diagnostics: mergeDiagnostics(parsed.diagnostics, idDiagnostics, nativeDiagnostics, additionalDiagnostics),
    }
  }

  private mutationResult(
    outcome: ProviderModelConfigMutationResponse['outcome'],
    parsed: ParsedModelsFile,
    additionalDiagnostics: readonly ProviderModelConfigDiagnostic[] = [],
  ): ProviderModelConfigMutationResponse {
    const state = this.makeState(parsed, additionalDiagnostics)
    return { outcome, state, diagnostics: mergeDiagnostics(additionalDiagnostics, state.diagnostics) }
  }

  private invalidProviderId(): ProviderModelConfigMutationResponse {
    return this.mutationResult('invalid', readParsed(this.modelsPath), [
      diagnostic('native-provider-id-invalid', 'Pi provider IDs must use letters, digits, dot, underscore, or hyphen.'),
    ])
  }

  private invalidRedactedInput(): ProviderModelConfigMutationResponse {
    return this.mutationResult('invalid', readParsed(this.modelsPath), [
      diagnostic('native-provider-invalid', 'Redacted write-only values must be omitted from provider updates.'),
    ])
  }

  private isAuthorized(): boolean {
    try {
      return this.authorizeMutation() === true
    } catch {
      return false
    }
  }

  private isCallerAuthorized(authorizeCaller: () => boolean): boolean {
    try {
      return authorizeCaller() === true
    } catch {
      return false
    }
  }

  private requireProviders(parsed: ParsedModelsFile): Record<string, unknown> {
    if (!parsed.providers) throw new TypeError('Pi native models.json must contain a providers object.')
    return parsed.providers
  }

  private atomicWrite(
    contents: string,
    beforePublish: () => 'unauthorized' | 'conflict' | 'invalid' | undefined,
  ): 'unauthorized' | 'conflict' | 'invalid' | undefined {
    const directory = dirname(this.modelsPath)
    ensureDirectory(directory)
    let existingMode = 0o600
    try {
      const existing = lstatSync(this.modelsPath)
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('The native models.json path is not a regular file.')
      existingMode = existing.mode & 0o666
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = join(directory, `.${randomUUID()}.models-json.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), existingMode)
      writeFileSync(descriptor, contents, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      const rejected = beforePublish()
      if (rejected) return rejected
      renameSync(temporary, this.modelsPath)
      try {
        const directoryDescriptor = openSync(directory, 'r')
        try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
      } catch {
        // Directory fsync is unavailable on some supported platforms.
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      try { unlinkSync(temporary) } catch { /* The rename already consumed the temporary file. */ }
    }
  }
}

function nativeDiagnostics(
  nativeErrors: readonly { readonly code: string; readonly path?: readonly string[] }[],
): readonly ProviderModelConfigDiagnostic[] {
  return nativeErrors.map((entry) => entry.code === 'schema-invalid'
    ? diagnostic('native-config-schema-invalid', 'Pi rejected fields in the native models.json schema.', entry.path)
    : diagnostic('native-provider-invalid', 'Pi could not compose one or more native provider definitions.'))
}
