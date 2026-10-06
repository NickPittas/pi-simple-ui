import { useState } from 'react';
import type { CodemodeCatalogResponse, CodemodeTrace } from '../../shared/codemode.ts';
import { CodeModeCallTree } from './CodeModeCallTree';

export interface CodeModeHistoryProps { readonly trace: CodemodeTrace; readonly catalog: CodemodeCatalogResponse | null }
export function CodeModeHistory({ trace, catalog }: CodeModeHistoryProps) {
  const [fullOutput, setFullOutput] = useState(false);
  const [fullScript, setFullScript] = useState(false);
  const output = trace.fullOutput ?? (trace.output === undefined ? '' : JSON.stringify(trace.output, null, 2));
  const script = trace.script;
  const visibleScript = !fullScript && script.length > 4000 ? `${script.slice(0, 4000)}\n…` : script;
  const visibleOutput = !fullOutput && output.length > 5000 ? `${output.slice(0, 5000)}\n…` : output;
  return <section className="codemode-history">
    <section className="codemode-script"><header><h3>Script</h3><button type="button" onClick={() => void navigator.clipboard?.writeText(script).catch(() => undefined)}>Copy script</button></header><pre>{visibleScript}</pre>{script.length > 4000 && <button type="button" className="codemode-inline-action" onClick={() => setFullScript((value) => !value)}>{fullScript ? 'Show less' : 'Show full script'}</button>}</section>
    <CodeModeCallTree calls={trace.calls} />
    <section className="codemode-output"><h3>Execution output</h3>{trace.error && <pre className="codemode-call-error" role="alert">{trace.error}</pre>}{output ? <><pre>{visibleOutput}</pre>{output.length > 5000 && <button type="button" className="codemode-inline-action" onClick={() => setFullOutput((value) => !value)}>{fullOutput ? 'Show less' : trace.fullOutput ? 'Load full retained output' : 'Show full output'}</button>}</> : trace.partialOutput !== undefined && <pre>{JSON.stringify(trace.partialOutput, null, 2)}</pre>}</section>
    <section className="codemode-readonly"><h3>Budgets and settings</h3><dl>{Object.entries(trace.budgets).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value === null ? 'No limit' : String(value)}</dd></div>)}{Object.entries(trace.settings).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{String(value)}</dd></div>)}</dl></section>
    {catalog && <details className="codemode-catalog"><summary>Tool catalog · {catalog.tools.length} tools</summary><p className="codemode-catalog-settings">Mode: {catalog.settings.mode} · Inline budget: {catalog.settings.inlineBudget} · Models {catalog.settings.modelsEnabled ? 'enabled' : 'disabled'}</p>{catalog.namespaces.map((namespace) => <details key={namespace.name}><summary>{namespace.name}</summary>{namespace.description && <p>{namespace.description}</p>}{namespace.instructions && <pre>{namespace.instructions}</pre>}<ul>{namespace.tools.map((name) => { const tool = catalog.tools.find((candidate) => candidate.name === name || `${candidate.namespace}.${candidate.name}` === name); return <li key={name}><strong>{name}</strong>{tool && <><p>{tool.description}</p><small>{tool.exposure}</small><details><summary>Input schema</summary><pre>{JSON.stringify(tool.parameters, null, 2)}</pre></details>{tool.outputSchema !== undefined && <details><summary>Output schema</summary><pre>{JSON.stringify(tool.outputSchema, null, 2)}</pre></details>}</>}</li>; })}</ul></details>)}</details>}
  </section>;
}
