import { createElement, Fragment, useState, type ReactNode } from 'react';
import { isRenderableLinkUrl } from '../../shared/content';
import './security.css';

export interface MessageSegment { readonly type: 'text' | 'code'; readonly content: string; readonly language?: string }
export interface SafeMarkdownProps { readonly source: string; readonly onOpenLink?: (url: string) => void; readonly collapsedLines?: number }

function inline(source: string, onOpenLink?: (url: string) => void, depth = 0): ReactNode[] {
  if (depth > 8) return [source];
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|!?\[[^\]]*\]\([^\s)]+(?:\s+"[^"]*")?\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) nodes.push(source.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith('`')) nodes.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={match.index}>{inline(token.slice(2, -2), onOpenLink, depth + 1)}</strong>);
    else if (token.startsWith('~~')) nodes.push(<del key={match.index}>{inline(token.slice(2, -2), onOpenLink, depth + 1)}</del>);
    else if (token.startsWith('*') || token.startsWith('_')) nodes.push(<em key={match.index}>{inline(token.slice(1, -1), onOpenLink, depth + 1)}</em>);
    else {
      const link = /^!?\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)$/.exec(token);
      if (link && !token.startsWith('!') && isRenderableLinkUrl(link[2]) && onOpenLink) nodes.push(<button className="safe-markdown-link" key={match.index} type="button" title={link[3]} onClick={() => onOpenLink(link[2])}>{inline(link[1], onOpenLink, depth + 1)}</button>);
      else if (link) nodes.push(link[1]);
      else nodes.push(token);
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) nodes.push(source.slice(cursor));
  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}

function renderBlocks(source: string, onOpenLink?: (url: string) => void): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(```+|~~~+)\s*([\w.+-]*)\s*$/.exec(line);
    if (fence) {
      i++;
      const body: string[] = [];
      while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      out.push(<pre className="safe-markdown-code" key={`b${i}`}><header><span>{fence[2] || 'Code'}</span><button type="button" onClick={(event) => { const button = event.currentTarget; void navigator.clipboard?.writeText(body.join('\n')).then(() => { button.textContent = 'Copied'; }).catch(() => undefined); }}>Copy</button></header><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { out.push(createElement(`h${heading[1].length}`, { className: 'safe-markdown-heading', key: `b${i++}` }, ...inline(heading[2], onOpenLink))); continue; }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { out.push(<hr key={`b${i++}`} />); continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={`b${i}`}>{renderBlocks(quote.join('\n'), onOpenLink)}</blockquote>); continue;
    }
    const list = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(line);
    if (list) {
      const ordered = !!list[2]; const entries: ReactNode[] = [];
      while (i < lines.length) { const entry = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(lines[i]); if (!entry || !!entry[2] !== ordered) break; entries.push(<li key={i}>{inline(entry[3], onOpenLink)}</li>); i++; }
      const Tag = ordered ? 'ol' : 'ul'; out.push(<Tag key={`b${i}`}>{entries}</Tag>); continue;
    }
    if (i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const cells = (value: string) => value.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const headers = cells(line); i += 2; const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(<div className="safe-markdown-table-wrap" key={`b${i}`}><table><thead><tr>{headers.map((cell, n) => <th key={n}>{inline(cell, onOpenLink)}</th>)}</tr></thead><tbody>{rows.map((row, n) => <tr key={n}>{headers.map((_, c) => <td key={c}>{inline(row[c] ?? '', onOpenLink)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(?:```|~~~)|\s*>|\s*(?:[-+*]|\d+[.)])\s+|\s*(?:---+|\*\*\*+|___+)\s*$)/.test(lines[i])) paragraph.push(lines[i++]);
    out.push(<p key={`b${i}`}>{paragraph.map((part, n) => <Fragment key={n}>{n > 0 && <br />}{inline(part, onOpenLink)}</Fragment>)}</p>);
  }
  return out;
}

export function renderMessageSegments(segments: readonly MessageSegment[], onOpenLink?: (url: string) => void): ReactNode[] {
  return segments.map((segment, index) => segment.type === 'code' ? <pre className="safe-markdown-code" key={index}><header><span>{segment.language || 'Code'}</span><button type="button" onClick={(event) => { const button = event.currentTarget; void navigator.clipboard?.writeText(segment.content).then(() => { button.textContent = 'Copied'; }).catch(() => undefined); }}>Copy</button></header><code>{segment.content}</code></pre> : <Fragment key={index}>{renderBlocks(segment.content, onOpenLink)}</Fragment>);
}

function collapseBoundary(lines: string[], limit: number): number {
  let end = Math.min(limit, lines.length);
  let fence: { character: string; length: number } | null = null;
  for (let i = 0; i < end; i++) {
    if (fence) {
      const closing = new RegExp(`^\\s*${fence.character}{${fence.length},}\\s*$`);
      if (closing.test(lines[i])) fence = null;
      continue;
    }
    const match = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (match) fence = { character: match[1][0], length: match[1].length };
  }
  if (fence) {
    const closing = new RegExp(`^\\s*${fence.character}{${fence.length},}\\s*$`);
    while (end < lines.length && !closing.test(lines[end++])) {}
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) continue;
    if (i >= end) break;
    let tableEnd = i + 2;
    while (tableEnd < lines.length && lines[tableEnd].includes('|') && lines[tableEnd].trim()) tableEnd++;
    if (i < end && tableEnd > end) end = tableEnd;
    i = tableEnd - 1;
  }
  return end;
}

export function SafeMarkdown({ source, onOpenLink, collapsedLines = 120 }: SafeMarkdownProps) {
  const [expanded, setExpanded] = useState(false);
  try {
    if (typeof source !== 'string') return <pre className="safe-markdown">{String(source)}</pre>;
    const lines = source.split('\n');
    const isLong = lines.length > collapsedLines;
    const visible = !expanded && isLong ? lines.slice(0, collapseBoundary(lines, collapsedLines)).join('\n') : source;
    return <div className="safe-markdown">{renderBlocks(visible, onOpenLink)}{isLong && <button className="safe-markdown-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show less' : 'Show more'}</button>}</div>;
  } catch {
    return <pre className="safe-markdown">{typeof source === 'string' ? source : 'Content unavailable'}</pre>;
  }
}
