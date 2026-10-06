import type { CSSProperties, ReactNode } from 'react';

// Renders native terminal-styled text (SGR colour/weight codes) as escaped React spans.
// Every other escape/control sequence is dropped; nothing from the input becomes markup or a URL.

const MAX_INPUT = 20_000;
const MAX_RUNS = 1_000;
// ANSI 0-15 mapped onto the app palette so plain terminal colours match the theme.
const BASIC = ['var(--c-surface1)', 'var(--c-red)', 'var(--c-green)', 'var(--c-yellow)', 'var(--c-blue)', 'var(--c-mauve)', 'var(--c-teal)', 'var(--c-subtext1)',
  'var(--c-surface2)', 'var(--c-red)', 'var(--c-green)', 'var(--c-yellow)', 'var(--c-blue)', 'var(--c-mauve)', 'var(--c-teal)', 'var(--c-text)'];
// CSI (incl. SGR), OSC (BEL or ST terminated), two-byte ESC sequences, then stray C0/DEL controls except tab/newline.
const CONTROL = /\x1b\[([0-9;:?<=>]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f]/g;

interface Sgr { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; inverse?: boolean }

const byte = (value: number | undefined) => Math.max(0, Math.min(255, value ?? 0));

function xterm256(n: number): string {
  if (n < 16) return BASIC[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v} ${v} ${v})`; }
  const i = n - 16; const step = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${step(Math.floor(i / 36))} ${step(Math.floor(i / 6) % 6)} ${step(i % 6)})`;
}

// Consumes an extended colour (38/48 ;5;n or ;2;r;g;b) starting after the 38/48 code.
function extended(codes: number[], at: number): [string | undefined, number] {
  if (codes[at] === 5) return [xterm256(byte(codes[at + 1])), at + 2];
  if (codes[at] === 2) return [`rgb(${byte(codes[at + 1])} ${byte(codes[at + 2])} ${byte(codes[at + 3])})`, at + 4];
  return [undefined, at];
}

function applySgr(state: Sgr, params: string): Sgr {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((part) => (part === '' ? 0 : Number.parseInt(part, 10)));
  let next: Sgr = { ...state };
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) { next.bold = false; next.dim = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.fg = BASIC[code - 30];
    else if (code >= 90 && code <= 97) next.fg = BASIC[code - 82];
    else if (code === 39) next.fg = undefined;
    else if (code >= 40 && code <= 47) next.bg = BASIC[code - 40];
    else if (code >= 100 && code <= 107) next.bg = BASIC[code - 92];
    else if (code === 49) next.bg = undefined;
    else if (code === 38 || code === 48) {
      const [colour, end] = extended(codes, i + 1);
      if (code === 38) next.fg = colour; else next.bg = colour;
      i = end - 1;
    }
  }
  return next;
}

function styleOf(sgr: Sgr): CSSProperties | undefined {
  const fg = sgr.inverse ? sgr.bg ?? 'var(--c-base)' : sgr.fg;
  const bg = sgr.inverse ? sgr.fg ?? 'var(--c-text)' : sgr.bg;
  const decoration = [sgr.underline && 'underline', sgr.strike && 'line-through'].filter(Boolean).join(' ');
  const style: CSSProperties = {};
  if (fg) style.color = fg;
  if (bg) { style.backgroundColor = bg; style.borderRadius = 2; }
  if (sgr.bold) style.fontWeight = 700;
  if (sgr.dim) style.opacity = 0.7;
  if (sgr.italic) style.fontStyle = 'italic';
  if (decoration) style.textDecoration = decoration;
  return Object.keys(style).length ? style : undefined;
}

/** Splits terminal text into styled runs; exported for reuse by other native-text surfaces. */
export function ansiRuns(text: string): { text: string; style?: CSSProperties }[] {
  const source = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text;
  const runs: { text: string; style?: CSSProperties }[] = [];
  let state: Sgr = {};
  let last = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    const style = styleOf(state);
    const prev = runs[runs.length - 1];
    if (prev && prev.style === undefined && style === undefined) prev.text += chunk;
    else runs.push({ text: chunk, style });
  };
  for (const match of source.matchAll(CONTROL)) {
    push(source.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] === 'm' && runs.length < MAX_RUNS) state = applySgr(state, match[1] ?? '');
  }
  push(source.slice(last));
  return runs;
}

export function AnsiText({ text, className }: { readonly text: string; readonly className?: string }) {
  const children: ReactNode[] = ansiRuns(text).map((run, index) => (run.style ? <span key={index} style={run.style}>{run.text}</span> : run.text));
  return <span className={className}>{children}</span>;
}
