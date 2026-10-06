/**
 * Narrow app-owned launch boundary for desktop transports. Requests describe a
 * Pi invocation as data; they never contain a shell command or script.
 */
export type HerdrLaunchKind = "fresh" | "resume" | "handoff" | "btw";

export interface HerdrLaunchTarget {
	/** The already-created pane/surface selected for this invocation. */
	surface: string;
	/** The actual working directory after cwd/worktree resolution. */
	cwd: string;
	/** The actual session file after creation/seeding. */
	sessionFile: string;
}

export interface HerdrLaunchBehavior {
	/** Preserve the native exit-code completion marker contract when enabled. */
	completionMarker: boolean;
	interactive: boolean;
	persistent: boolean;
	/** Subagent and BTW panes are launched detached from the parent turn. */
	detached: true;
}

/**
 * Bounded structured invocation. argv contains Pi arguments only (no
 * executable token); environment contains behavior variables only (never the
 * selected desktop executable or PI_CODING_AGENT_DIR).
 */
export interface HerdrLaunchRequest {
	kind: HerdrLaunchKind;
	target: HerdrLaunchTarget;
	argv: readonly string[];
	environment: Readonly<Record<string, string>>;
	behavior: HerdrLaunchBehavior;
}

/** App transport execution reference; this need not be a local script path. */
export interface HerdrLaunchResult {
	launchScriptFile: string;
}

/**
 * App-owned authorization and execution port. `prepare` must authorize this
 * exact target and invocation; `runPrepared` accepts only that prepared value.
 * The extension never interprets the prepared value or falls back to native
 * Pi execution in desktop mode.
 */
export interface HerdrLaunchHost<Prepared = unknown> {
	prepare(request: HerdrLaunchRequest): Promise<Prepared> | Prepared;
	runPrepared(prepared: Prepared): Promise<HerdrLaunchResult> | HerdrLaunchResult;
}

export type SubagentsLaunchOptions =
	| { launchMode?: "native"; launchHost?: never }
	| { launchMode: "desktop"; launchHost: HerdrLaunchHost<any> };

export type SubagentsLaunchExecution =
	| { mode: "native" }
	| { mode: "desktop"; host: HerdrLaunchHost<any> };

const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 128_000;
const MAX_ENV_VARS = 32;
const MAX_ENV_VALUE_LENGTH = 32_000;
const MAX_REQUEST_TEXT_LENGTH = 512_000;

/** Runtime validation keeps JS consumers within the same bounded contract. */
export function validateHerdrLaunchRequest(
	request: HerdrLaunchRequest,
): void {
	if (
		!request ||
		!(["fresh", "resume", "handoff", "btw"] as const).includes(request.kind)
	) {
		throw new Error("Desktop launch kind is invalid");
	}
	if (!request.target || !Array.isArray(request.argv)) {
		throw new Error("Desktop launch request is invalid");
	}
	if (
		typeof request.target.surface !== "string" ||
		!request.target.surface ||
		typeof request.target.cwd !== "string" ||
		!request.target.cwd ||
		typeof request.target.sessionFile !== "string" ||
		!request.target.sessionFile
	) {
		throw new Error("Desktop launch requires a resolved surface, cwd, and session");
	}
	if (request.argv.length > MAX_ARGS) {
		throw new Error(`Desktop launch has too many arguments (maximum ${MAX_ARGS})`);
	}
	let totalLength =
		request.target.surface.length +
		request.target.cwd.length +
		request.target.sessionFile.length;
	for (const arg of request.argv) {
		if (typeof arg !== "string" || arg.length > MAX_ARG_LENGTH) {
			throw new Error("Desktop launch argument exceeds the supported bound");
		}
		totalLength += arg.length;
	}
	if (!request.environment || typeof request.environment !== "object") {
		throw new Error("Desktop launch environment is invalid");
	}
	if (
		!request.behavior ||
		typeof request.behavior.completionMarker !== "boolean" ||
		typeof request.behavior.interactive !== "boolean" ||
		typeof request.behavior.persistent !== "boolean" ||
		request.behavior.detached !== true
	) {
		throw new Error("Desktop launch behavior is invalid");
	}
	const entries = Object.entries(request.environment);
	if (entries.length > MAX_ENV_VARS) {
		throw new Error(`Desktop launch has too many environment values (maximum ${MAX_ENV_VARS})`);
	}
	for (const [key, value] of entries) {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== "string") {
			throw new Error("Desktop launch environment is invalid");
		}
		if (value.length > MAX_ENV_VALUE_LENGTH) {
			throw new Error(`Desktop launch environment value exceeds the supported bound: ${key}`);
		}
		totalLength += key.length + value.length;
	}
	if (totalLength > MAX_REQUEST_TEXT_LENGTH) {
		throw new Error("Desktop launch request exceeds the supported size");
	}
}
