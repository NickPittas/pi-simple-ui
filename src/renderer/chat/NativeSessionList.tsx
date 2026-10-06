import { useMemo, useState } from 'react';
import type { NativeSessionSummary } from '../../shared/native-pi.ts';
import './native-sessions.css';

type Props = { sessions: NativeSessionSummary[]; sessionId: string | null; loading: boolean; error: string | null; pending: boolean; onNew: () => void; onOpen: (file: string) => void };

const SEARCH_THRESHOLD = 5;

function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = now - t;
  if (diff < 45_000) return 'just now'; // also covers small future clock skew
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${Math.max(min, 1)} min ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours} h ago`;
  const date = new Date(t);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (t >= startOfToday.getTime() - 86_400_000 && t < startOfToday.getTime()) return 'yesterday';
  try { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) }).format(date); } catch { return ''; }
}

const PAPERCLIP = '\uf0c6';
const ATTACH_OPEN = /^<(file|skill|attachment|image)\b[^>]*?\bname="([^"]+)"[^>]*>/i;

type DisplayTitle = { title: string; icon: 'attachment' | null; attachments: number; tooltip: string };

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Pure: derive the row title from a session summary, unwrapping leading attachment markup. */
function displayTitle(s: NativeSessionSummary): DisplayTitle {
  const name = s.name?.trim();
  if (name) return { title: name, icon: null, attachments: 0, tooltip: name };
  const raw = s.firstMessage?.trim() ?? '';
  if (!raw) return { title: 'Untitled session', icon: null, attachments: 0, tooltip: 'Untitled session' };
  let rest = raw;
  const labels: string[] = [];
  const paths: string[] = [];
  for (;;) {
    const m = ATTACH_OPEN.exec(rest);
    if (!m) break;
    const kind = m[1].toLowerCase();
    labels.push(kind === 'skill' ? `skill: ${m[2]}` : baseName(m[2]));
    paths.push(m[2]);
    const after = rest.slice(m[0].length);
    const close = after.toLowerCase().indexOf(`</${kind}>`);
    rest = close === -1 ? '' : after.slice(close + kind.length + 3).trim();
  }
  if (!labels.length) return { title: raw, icon: null, attachments: 0, tooltip: raw };
  if (rest) return { title: rest, icon: null, attachments: labels.length, tooltip: `${rest}\n\n${paths.join('\n')}` };
  const title = `${labels[0]}${labels.length > 1 ? ` +${labels.length - 1}` : ''}`;
  return { title, icon: 'attachment', attachments: 0, tooltip: paths.join('\n') };
}

export function NativeSessionList({ sessions, sessionId, loading, error, pending, onNew, onOpen }: Props) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? sessions.filter((s) => `${displayTitle(s).title}\n${s.name ?? ''}\n${s.firstMessage ?? ''}`.toLowerCase().includes(q)) : sessions),
    [sessions, q],
  );
  const showSearch = sessions.length > SEARCH_THRESHOLD;
  const searching = showSearch && q.length > 0;
  const rows = searching ? filtered : sessions;

  return <section className="ns" aria-label="Sessions">
    <div className="ns-head">
      <span className="ns-label">Sessions{sessions.length > 0 && <span className="ns-count" aria-label={`${sessions.length} sessions`}>{sessions.length}</span>}</span>
      <button type="button" className="ns-new" disabled={pending} onClick={onNew}>New chat</button>
    </div>
    {showSearch && <input type="search" className="ns-search" aria-label="Search sessions" placeholder="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />}
    {loading && <p className="ns-note" role="status">Loading sessions…</p>}
    {error && <p className="ns-note ns-error" role="status">{error}</p>}
    {!loading && !error && !sessions.length && <p className="ns-note" role="status">No saved sessions in this folder yet.</p>}
    {searching && !filtered.length && <p className="ns-note" role="status">No sessions match “{query.trim()}”.</p>}
    {rows.length > 0 && <ul className="ns-list">{rows.map((s) => {
      const current = s.sessionId === sessionId;
      const { title, icon, attachments, tooltip } = displayTitle(s);
      const when = relativeTime(s.modified);
      const meta = [when, `${s.messageCount} ${s.messageCount === 1 ? 'msg' : 'msgs'}`].filter(Boolean).join(' · ');
      return <li key={s.file}><button type="button" className="ns-row" disabled={pending} aria-current={current ? 'page' : undefined} title={tooltip} onClick={() => { if (!current) onOpen(s.file); }}>
        <span className="ns-title">{icon && <span className="ns-icon" aria-hidden="true">{PAPERCLIP}</span>}<span className="ns-title-text">{title}</span></span>
        <span className="ns-meta"><span className="ns-meta-text">{meta}</span>{attachments > 0 && <span className="ns-attach"><span className="ns-icon" aria-hidden="true">{PAPERCLIP}</span>{attachments} {attachments === 1 ? 'file' : 'files'}</span>}{s.branched && <span className="ns-badge">branch</span>}</span>
      </button></li>;
    })}</ul>}
  </section>;
}
