// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Message, type ConversationMessageData } from './Message'

afterEach(cleanup)

function renderMessage(message: ConversationMessageData) {
  const { container } = render(<Message message={message} />)
  const article = container.querySelector('article')!
  return { article, badge: container.querySelector('.chat-role-badge')!.textContent ?? '', container }
}
const classes = (el: Element) => Array.from(el.classList)

describe('Message command notices', () => {
  it('renders a warning notice', () => {
    const { article, badge } = renderMessage({ id: 'notice:1', role: 'system', customType: 'command-notice', level: 'warning', content: 'done' })
    expect(classes(article)).toEqual(expect.arrayContaining(['chat-message', 'chat-message-system', 'chat-notice', 'chat-notice-warning']))
    expect(badge).toContain('Command')
    expect(article.getAttribute('data-message-id')).toBe('notice:1')
    expect(article.textContent).toContain('done')
  })

  it('renders an error notice', () => {
    const { article, badge } = renderMessage({ id: 'n', role: 'error', customType: 'command-notice', level: 'error', content: 'bad' })
    expect(classes(article)).toEqual(expect.arrayContaining(['chat-message-error', 'chat-notice', 'chat-notice-error']))
    expect(badge).toContain('Command')
  })

  it('defaults notice level to info', () => {
    const { article } = renderMessage({ id: 'n', role: 'system', customType: 'command-notice', content: 'x' })
    expect(classes(article)).toContain('chat-notice-info')
  })
})

describe('Message badges', () => {
  it('labels subagent custom types', () => {
    const { article, badge } = renderMessage({ id: 's', role: 'system', customType: 'subagent-result', content: 'x' })
    expect(badge).toContain('Subagent')
    expect(classes(article)).not.toContain('chat-notice')
  })

  it('labels other custom types as Extension', () => {
    expect(renderMessage({ id: 'e', role: 'system', customType: 'foo', content: 'x' }).badge).toContain('Extension')
  })

  it('uses the role label without a custom type', () => {
    const { article, badge } = renderMessage({ id: 'r', role: 'system', content: 'x' })
    expect(badge).toContain('System')
    expect(article.className).not.toContain('chat-notice')
  })

  it('renders a time element for numeric timestamps', () => {
    const { container } = renderMessage({ id: 't', role: 'user', content: 'x', timestamp: 1_700_000_000_000 })
    expect(container.querySelector('time')).not.toBeNull()
  })
})
