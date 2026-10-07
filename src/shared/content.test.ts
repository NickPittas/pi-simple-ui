import { describe, expect, it } from 'vitest'
import {
  CONTENT_LIMITS,
  attachmentTypeForExtension,
  attachmentTypeForName,
  classifyContent,
  getBase64ByteLength,
  isAllowedAttachmentMimeType,
  isAttachmentCountWithinLimit,
  isAttachmentReadRequest,
  isAttachmentReadResponse,
  isAttachmentSizeWithinLimit,
  isBoundedImageDataUri,
  isExportWriteRequest,
  isExportWriteResponse,
  isRenderableLinkUrl,
  isSafeAttachmentName,
  isSafeExportName,
} from './content.ts'

describe('CONTENT_LIMITS', () => {
  it('is frozen with the documented values', () => {
    expect(Object.isFrozen(CONTENT_LIMITS)).toBe(true)
    expect(CONTENT_LIMITS).toMatchObject({
      attachmentBytes: 7_500_000,
      attachmentBase64Characters: 10_000_000,
      inlineImageBytes: 1_000_000,
      attachmentsPerMessage: 20,
      attachmentNameCharacters: 255,
    })
  })
})

describe('attachment type lookup', () => {
  it('resolves extensions case-insensitively with or without a dot', () => {
    expect(attachmentTypeForExtension('png')).toEqual({ category: 'image', mime: 'image/png' })
    expect(attachmentTypeForExtension('.PNG')).toEqual({ category: 'image', mime: 'image/png' })
    expect(attachmentTypeForExtension('.jpeg')?.mime).toBe('image/jpeg')
    expect(attachmentTypeForExtension('.exe')).toBeNull()
  })

  it('resolves names by the last dot', () => {
    expect(attachmentTypeForName('a.ts')).toEqual({ category: 'code', mime: 'text/plain' })
    expect(attachmentTypeForName('x.tar.gz')).toBeNull()
    expect(attachmentTypeForName('noext')).toBeNull()
    expect(attachmentTypeForName('README.MD')?.mime).toBe('text/markdown')
  })
})

describe('classifyContent', () => {
  it('classifies uri, code and text', () => {
    expect(classifyContent('https://x.y')).toBe('uri')
    expect(classifyContent('hello', 'a.ts')).toBe('code')
    expect(classifyContent('hello', 'a.md')).toBe('text')
    expect(classifyContent('hello')).toBe('text')
  })
})

describe('limit checks', () => {
  it('bounds attachment count', () => {
    for (const n of [0, 20]) expect(isAttachmentCountWithinLimit(n)).toBe(true)
    for (const n of [-1, 21, 1.5, NaN]) expect(isAttachmentCountWithinLimit(n)).toBe(false)
  })

  it('bounds attachment size', () => {
    expect(isAttachmentSizeWithinLimit(7_500_000)).toBe(true)
    for (const n of [7_500_001, -1, NaN]) expect(isAttachmentSizeWithinLimit(n)).toBe(false)
  })

  it('allows only listed mime types', () => {
    expect(isAllowedAttachmentMimeType('image/webp')).toBe(true)
    expect(isAllowedAttachmentMimeType('text/csv')).toBe(true)
    for (const v of ['image/svg+xml', 'text/html', 5]) expect(isAllowedAttachmentMimeType(v)).toBe(false)
  })
})

describe('getBase64ByteLength', () => {
  it('counts decoded bytes', () => {
    expect(getBase64ByteLength('')).toBe(0)
    expect(getBase64ByteLength('QQ==')).toBe(1)
    expect(getBase64ByteLength('QUI=')).toBe(2)
    expect(getBase64ByteLength('QUJD')).toBe(3)
  })

  it('rejects malformed input', () => {
    for (const v of ['QQ=', 'QQ-_', 'QQ==QUJD', '====']) expect(getBase64ByteLength(v)).toBeNull()
  })

  it('respects maxCharacters', () => {
    expect(getBase64ByteLength('QUJD', 3)).toBeNull()
  })
})

describe('isBoundedImageDataUri', () => {
  it('accepts raster data URIs, case-insensitively', () => {
    for (const t of ['png', 'jpeg', 'gif', 'webp']) expect(isBoundedImageDataUri(`data:image/${t};base64,QUJD`)).toBe(true)
    expect(isBoundedImageDataUri('DATA:IMAGE/PNG;BASE64,QUJD')).toBe(true)
  })

  it('rejects svg, empty, non-base64 and oversized payloads', () => {
    expect(isBoundedImageDataUri('data:image/svg+xml;base64,QUJD')).toBe(false)
    expect(isBoundedImageDataUri('data:image/png;base64,')).toBe(false)
    expect(isBoundedImageDataUri('data:image/png,QUJD')).toBe(false)
    expect(isBoundedImageDataUri(`data:image/png;base64,${'A'.repeat(1_333_336)}`)).toBe(false)
  })
})

describe('isRenderableLinkUrl', () => {
  it('accepts http, https and mailto', () => {
    for (const u of ['https://a.b/c', 'http://a.b', 'mailto:x@y']) expect(isRenderableLinkUrl(u)).toBe(true)
  })

  it('rejects unsafe or malformed urls', () => {
    const longUrl = `https://a.b/${'x'.repeat(8193 - 12)}`
    for (const u of ['javascript:alert(1)', 'https://u:p@a.b', 'https://a.b/\u0007', 'http://a.b\\c', '', longUrl, 'file:///x']) {
      expect(isRenderableLinkUrl(u)).toBe(false)
    }
    expect(longUrl).toHaveLength(8193)
  })
})

describe('name safety', () => {
  it('validates attachment names', () => {
    expect(isSafeAttachmentName('a.png')).toBe(true)
    for (const n of ['', '.', '..', 'a/b', 'a\\b', 'a\u0000', 'a'.repeat(256)]) expect(isSafeAttachmentName(n)).toBe(false)
  })

  it('validates export names more strictly', () => {
    expect(isSafeExportName('a.png')).toBe(true)
    for (const n of ['a.', 'a'.repeat(129), '', '..', 'a/b']) expect(isSafeExportName(n)).toBe(false)
  })
})

describe('request/response validators', () => {
  const read = { workspacePath: '/w', relativeOrAbsPath: 'a.txt' }

  it('validates read requests', () => {
    expect(isAttachmentReadRequest(read)).toBe(true)
    expect(isAttachmentReadRequest({ ...read, extra: 1 })).toBe(false)
    expect(isAttachmentReadRequest({ ...read, relativeOrAbsPath: '' })).toBe(false)
    expect(isAttachmentReadRequest({ ...read, relativeOrAbsPath: 'a\0' })).toBe(false)
    expect(isAttachmentReadRequest({ ...read, relativeOrAbsPath: 'a'.repeat(4097) })).toBe(false)
  })

  const resp = { name: 'a.txt', mime: 'text/plain', bytesBase64: 'QUJD', byteLength: 3 }

  it('validates read responses', () => {
    expect(isAttachmentReadResponse(resp)).toBe(true)
    expect(isAttachmentReadResponse({ ...resp, byteLength: 2 })).toBe(false)
    expect(isAttachmentReadResponse({ ...resp, mime: 'text/html' })).toBe(false)
    expect(isAttachmentReadResponse({ ...resp, name: 'a/b' })).toBe(false)
    expect(isAttachmentReadResponse({ ...resp, extra: 1 })).toBe(false)
  })

  it('validates export requests and responses', () => {
    expect(isExportWriteRequest({ suggestedName: 'a.txt', bytesBase64: 'QUJD' })).toBe(true)
    expect(isExportWriteRequest({ suggestedName: 'a.', bytesBase64: 'QUJD' })).toBe(false)
    expect(isExportWriteResponse({ path: null })).toBe(true)
    expect(isExportWriteResponse({ path: '/x' })).toBe(true)
    expect(isExportWriteResponse({ path: '' })).toBe(false)
    expect(isExportWriteResponse({ path: 'a\0' })).toBe(false)
  })
})
