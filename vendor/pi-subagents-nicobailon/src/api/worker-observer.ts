import { join, resolve } from "node:path";
import { DIRS, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, TEMP_ROOT_DIR } from "../shared/types.ts";

/** Public event seam for hosts that need to observe Pi-native subagent sessions. */
export { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT };
export const SUBAGENT_WORKER_EVENT = "pi-subagents:worker-observer:v1";

/** Resolve the same per-process async run root used by the extension. */
export function subagentAsyncRunsDirectory(): string {
	return resolve(DIRS.async);
}

/** Resolve the extension-owned root for authenticated nested-run event records. */
export function subagentNestedEventsDirectory(): string {
	return resolve(join(TEMP_ROOT_DIR, "nested-subagent-events"));
}

export interface SubagentWorkerControls {
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
}

export interface SubagentWorkerObservation {
	version: 1;
	type: "child-started" | "child-event" | "child-settled";
	runId: string;
	index: number;
	agent: string;
	cwd: string;
	parentSessionId: string | null;
	/** Native Pi tool call that invoked the observed worker run, when available. */
	toolCallId?: string;
	sessionId: string | null;
	sessionFile: string | null;
	timestamp: number;
	event?: unknown;
	status?: "completed" | "failed" | "aborted";
	model?: string;
	error?: string;
	usage?: { input: number; output: number; cacheWrite: number; cost: number };
	controls?: SubagentWorkerControls;
}

export interface SubagentWorkerObserverHost {
	emit(event: string, payload: SubagentWorkerObservation): void;
}

/** Emit one in-process observation without replacing or wrapping global callbacks. */
export function publishSubagentWorkerObservation(
	host: SubagentWorkerObserverHost | undefined,
	observation: SubagentWorkerObservation,
): void {
	try {
		host?.emit(SUBAGENT_WORKER_EVENT, observation);
	} catch {
		// Observation is advisory and must not interfere with child execution.
	}
}
