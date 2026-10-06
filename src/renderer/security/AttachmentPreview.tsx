import { useState } from 'react';
import { attachmentTypeForName, isAllowedAttachmentMimeType, isAttachmentSizeWithinLimit, isBoundedImageDataUri, isSafeAttachmentName, type AttachmentMimeType } from '../../shared/content';
import './security.css';

export interface AttachmentDescriptor { readonly name: string; readonly mime: string; readonly byteLength: number; readonly objectUrl?: string; readonly base64Data?: string; readonly textContent?: string }
export interface AttachmentPreviewProps { readonly attachment: AttachmentDescriptor; readonly onRemove?: () => void; readonly onDownload?: (attachment: AttachmentDescriptor) => void; readonly textPreviewLines?: number }

function sizeLabel(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`; }
function imageSource(attachment: AttachmentDescriptor): string | null {
  if (!isAllowedAttachmentMimeType(attachment.mime) || !attachment.mime.startsWith('image/')) return null;
  if (attachment.objectUrl?.startsWith('blob:')) return attachment.objectUrl;
  if (attachment.base64Data) { const uri = `data:${attachment.mime};base64,${attachment.base64Data}`; return isBoundedImageDataUri(uri) ? uri : null; }
  return null;
}

export function AttachmentPreview({ attachment, onRemove, onDownload, textPreviewLines = 8 }: AttachmentPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const safeName = isSafeAttachmentName(attachment.name) ? attachment.name : 'Attachment';
  const allowedMime = isAllowedAttachmentMimeType(attachment.mime);
  const supported = allowedMime && attachmentTypeForName(safeName)?.mime === attachment.mime;
  const validSize = isAttachmentSizeWithinLimit(attachment.byteLength);
  const image = supported && validSize ? imageSource(attachment) : null;
  const isPdf = supported && attachment.mime === 'application/pdf';
  const isText = supported && (attachment.mime.startsWith('text/') || attachment.mime === 'application/json');
  const lines = attachment.textContent?.split('\n') ?? [];
  const truncated = lines.length > textPreviewLines;
  const snippet = !expanded && truncated ? lines.slice(0, textPreviewLines).join('\n') : attachment.textContent;
  const icon = image ? '▧' : isPdf ? 'PDF' : isText ? '</>' : 'FILE';
  return <article className="attachment-preview" aria-label={`${safeName}, ${sizeLabel(attachment.byteLength)}`}>
    {image ? <img className="attachment-thumbnail" src={image} alt={`Preview of ${safeName}`} loading="lazy" decoding="async" /> : <span className="attachment-icon" aria-hidden="true">{icon}</span>}
    <div className="attachment-details"><strong title={safeName}>{safeName}</strong><span>{validSize ? sizeLabel(attachment.byteLength) : 'Size unavailable'}{allowedMime ? ` · ${attachment.mime as AttachmentMimeType}` : ' · Unsupported format'}</span>
      {isPdf && <p className="attachment-note">PDF preview is not available.</p>}
      {isText && typeof snippet === 'string' && <><pre className="attachment-text-snippet">{snippet}</pre>{truncated && <button className="attachment-action" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show less' : 'Show full text'}</button>}</>}
    </div>
    <div className="attachment-actions">{onDownload && <button type="button" aria-label={`Download ${safeName}`} onClick={() => onDownload(attachment)}>Download</button>}{onRemove && <button type="button" aria-label={`Remove ${safeName}`} onClick={onRemove}>Remove</button>}</div>
  </article>;
}
