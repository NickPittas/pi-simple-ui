import { createElement, type ComponentType } from 'react';
import type { JSONValue } from '@earendil-works/pi-coding-agent';
import { SubagentsSettingsView } from './tintinweb/SubagentsSettingsView';
import { AgentsMenuView } from './tintinweb/AgentsMenuView';
import { ConversationSurface } from './tintinweb/ConversationSurface';
import { FleetView } from './tintinweb/FleetView';
import { WorkflowsView } from './tintinweb/WorkflowsView';
import { WebAccessActivityView } from './WebAccessActivityView';
import { ExtensionFallback } from './ExtensionFallback';
import './adapters.css';

export interface SemanticViewProps {
  readonly viewId: string;
  readonly version: number;
  readonly ownerId: string;
  readonly instanceId: string;
  readonly revision: number;
  readonly state: JSONValue;
  readonly onAction: (action: JSONValue) => void;
}

type Adapter = ComponentType<SemanticViewProps>;
const registry = new Map<string, Adapter>([
  ['pi-subagents.settings@1', SubagentsSettingsView],
  ['pi-subagents.agents-menu@1', AgentsMenuView],
  ['pi-subagents.conversation@1', ConversationSurface],
  ['pi-subagents.fleet@1', FleetView],
  ['pi-subagents.workflows@1', WorkflowsView],
  ['pi-web-access.activity@1', WebAccessActivityView],
]);

export function resolveSemanticView(viewId: string, version: number): Adapter | undefined {
  return registry.get(`${viewId}@${version}`);
}

export function SemanticViewRenderer(props: SemanticViewProps) {
  const AdapterView = resolveSemanticView(props.viewId, props.version);
  return createElement(AdapterView ?? ExtensionFallback, props);
}
