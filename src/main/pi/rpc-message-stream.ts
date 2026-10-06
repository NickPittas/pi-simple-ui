import type { Json } from '../../shared/native-pi.ts'

export type RpcMessageStream = { receive(record: Json): Json; partial(): Json | null; reset(): void }

type JsonRecord = { [key: string]: Json }
const isRecord = (value: Json | undefined): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value)
const clone = (value: Json): Json => Array.isArray(value) ? value.map(clone) : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value

export function createRpcMessageStream(): RpcMessageStream {
  let current: JsonRecord | null = null

  const snapshot = (): Json | null => current ? clone(current) : null
  const matches = (message: JsonRecord): boolean => current !== null
    && current.role === 'assistant'
    && message.role === 'assistant'
    && !(typeof current.id === 'string' && typeof message.id === 'string' && current.id !== message.id)

  return {
    receive(record) {
      if (!isRecord(record)) return record
      const type = record.type
      if (type === 'message_start' && isRecord(record.message) && record.message.role === 'assistant') {
        current = clone(record.message) as JsonRecord
        return record
      }
      if (type === 'message_end' && isRecord(record.message) && matches(record.message)) {
        current = null
        return record
      }
      if (type !== 'message_update' || !current || !isRecord(record.assistantMessageEvent)) return record

      const event = record.assistantMessageEvent
      const index = event.contentIndex
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || !Array.isArray(current.content)) return record
      const content = current.content
      if (index > content.length) return record
      while (content.length <= index) content.push(null)
      const block = content[index]
      switch (event.type) {
        case 'text_start':
          content[index] = { type: 'text', text: '' }
          break
        case 'text_delta':
          if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && typeof event.delta === 'string') {
            content[index] = { ...block, text: block.text + event.delta }
          }
          break
        case 'text_end':
          if (isRecord(block) && block.type === 'text' && typeof event.content === 'string') {
            content[index] = { ...block, text: event.content }
          }
          break
        case 'thinking_start':
          content[index] = { type: 'thinking', thinking: '' }
          break
        case 'thinking_delta':
          if (isRecord(block) && block.type === 'thinking' && typeof block.thinking === 'string' && typeof event.delta === 'string') {
            content[index] = { ...block, thinking: block.thinking + event.delta }
          }
          break
        case 'thinking_end':
          if (isRecord(block) && block.type === 'thinking' && typeof event.content === 'string') {
            content[index] = { ...block, thinking: event.content }
          }
          break
        case 'toolcall_start':
          if (typeof event.id === 'string' && typeof event.toolName === 'string') {
            content[index] = { type: 'toolCall', id: event.id, name: event.toolName }
          }
          break
        case 'toolcall_end':
          if (isRecord(event.toolCall) && event.toolCall.type === 'toolCall') content[index] = clone(event.toolCall)
          break
      }
      if (isRecord(record.usage)) current.usage = clone(record.usage)
      return { ...record, message: snapshot()! }
    },
    partial: snapshot,
    reset() { current = null },
  }
}
