import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_RADIUS_GATEWAY } from "@earendil-works/pi-ai/providers/radius-config";
import { getAuthCredential } from "../cli/auth-command.ts";
import { getShareViewerUrl } from "../config.ts";
import type { AgentSession } from "./agent-session.ts";
import { exportSessionToJsonl } from "./session-export.ts";

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024;
const MAX_RADIUS_RESPONSE_BYTES = 64 * 1024;

export type NativeSessionShareDestination = "radius-organization" | "github-private-gist";

export type NativeSessionShareProgressPhase =
	| "exporting-jsonl"
	| "checking-radius-auth"
	| "uploading-radius"
	| "checking-github-auth"
	| "exporting-html"
	| "creating-gist";

export interface NativeSessionShareProgress {
	readonly phase: NativeSessionShareProgressPhase;
}

export type NativeSessionShareOutcome =
	| {
			readonly status: "shared";
			readonly destination: "radius-organization";
			readonly url: string;
	  }
	| {
			readonly status: "shared";
			readonly destination: "github-private-gist";
			readonly url: string;
			readonly gistUrl: string;
	  }
	| { readonly status: "cancelled" }
	| {
			readonly status: "failed";
			readonly phase: NativeSessionShareProgressPhase;
			readonly message: string;
	  };

export interface NativeSessionShareOptions {
	readonly signal: AbortSignal;
	readonly onProgress?: (progress: NativeSessionShareProgress) => void;
	readonly htmlThemeName?: string;
}

interface ProcessResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: NodeJS.ErrnoException;
	readonly aborted: boolean;
}

/** Trailing pi.share entry carrying the system prompt and tool schemas for the session viewer. */
export function createShareTrailingEntries(
	session: AgentSession,
	parentId: string | null,
	timestamp: string,
): object[] {
	return [
		{
			type: "custom",
			customType: "pi.share",
			id: crypto.randomUUID().slice(0, 8),
			parentId,
			timestamp,
			data: {
				systemPrompt: session.state.systemPrompt,
				tools: session.state.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		},
	];
}

/** Export the current branch with presentation metadata for Radius. */
export function exportSessionForShare(filePath: string, session: AgentSession): void {
	exportSessionToJsonl(session.sessionManager, filePath, (parentId, timestamp) =>
		createShareTrailingEntries(session, parentId, timestamp),
	);
}

/**
 * Share using Pi's native route order: Radius organization artifacts first, then
 * an unlisted private GitHub gist only when Radius is unavailable or unauthenticated.
 */
export async function shareSessionNative(
	session: AgentSession,
	options: NativeSessionShareOptions,
): Promise<NativeSessionShareOutcome> {
	let phase: NativeSessionShareProgressPhase = "exporting-jsonl";
	let tempDir: string | undefined;
	const reportProgress = (nextPhase: NativeSessionShareProgressPhase): void => {
		phase = nextPhase;
		try {
			options.onProgress?.({ phase });
		} catch {
			// Progress observers cannot change the sharing operation's result.
		}
	};
	const failed = (message: string): NativeSessionShareOutcome => ({
		status: "failed",
		phase,
		message: safeMessage(message),
	});
	try {
		throwIfAborted(options.signal);
		reportProgress("exporting-jsonl");
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-"));
		const jsonlFile = path.join(tempDir, "session.jsonl");
		const htmlFile = path.join(tempDir, "session.html");
		try {
			exportSessionForShare(jsonlFile, session);
		} catch (error: unknown) {
			return failed(`Failed to export session: ${errorMessage(error)}`);
		}
		throwIfAborted(options.signal);

		reportProgress("checking-radius-auth");
		const provider = session.modelRuntime.getProvider("radius");
		if (provider) {
			let token: string | undefined;
			try {
				const auth = await session.modelRuntime.getAuth("radius", {
					minOAuthValidityMs: 5 * 60_000,
					signal: options.signal,
				});
				token = getAuthCredential(auth);
			} catch (error: unknown) {
				if (options.signal.aborted) return { status: "cancelled" };
				return failed(`Failed to authenticate with Radius: ${errorMessage(error)}`);
			}
			throwIfAborted(options.signal);
			if (token) {
				reportProgress("uploading-radius");
				const result = await uploadRadiusArtifact(jsonlFile, token, options.signal);
				if (result.status === "cancelled") return result;
				if (result.status === "failed") return failed(result.message);
				return { status: "shared", destination: "radius-organization", url: result.url };
			}
		}

		reportProgress("checking-github-auth");
		const authStatus = await runCommand("gh", ["auth", "status"], options.signal);
		if (authStatus.aborted || options.signal.aborted) return { status: "cancelled" };
		if (authStatus.error?.code === "ENOENT") {
			return failed("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
		}
		if (authStatus.error || authStatus.code !== 0) {
			return failed("GitHub CLI is not logged in. Run 'gh auth login' first.");
		}

		throwIfAborted(options.signal);
		reportProgress("exporting-html");
		try {
			await session.exportToHtml(htmlFile, {
				...(options.htmlThemeName === undefined ? {} : { themeName: options.htmlThemeName }),
			});
		} catch (error: unknown) {
			if (options.signal.aborted) return { status: "cancelled" };
			return failed(`Failed to export session: ${errorMessage(error)}`);
		}
		throwIfAborted(options.signal);

		reportProgress("creating-gist");
		const gistResult = await runCommand("gh", ["gist", "create", "--public=false", htmlFile], options.signal);
		if (gistResult.aborted || options.signal.aborted) return { status: "cancelled" };
		if (gistResult.error || gistResult.code !== 0) {
			return failed(`Failed to create gist: ${gistResult.stderr.trim() || "Unknown error"}`);
		}
		const gistUrl = parseGistUrl(gistResult.stdout.trim());
		if (!gistUrl) return failed("Failed to parse gist ID from gh output");
		const gistId = new URL(gistUrl).pathname.split("/").filter(Boolean).at(-1);
		if (!gistId) return failed("Failed to parse gist ID from gh output");
		return {
			status: "shared",
			destination: "github-private-gist",
			url: getShareViewerUrl(gistId),
			gistUrl,
		};
	} catch (error: unknown) {
		if (options.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
			return { status: "cancelled" };
		}
		return failed(errorMessage(error));
	} finally {
		if (tempDir) {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// A single best-effort removal owns all temporary artifacts.
			}
		}
	}
}

async function uploadRadiusArtifact(
	jsonlFile: string,
	token: string,
	signal: AbortSignal,
): Promise<
	| { readonly status: "uploaded"; readonly url: string }
	| { readonly status: "cancelled" }
	| { readonly status: "failed"; readonly message: string }
> {
	try {
		throwIfAborted(signal);
		const failed = (message: string) => ({ status: "failed" as const, message: safeMessage(message, token) });
		const body = fs.readFileSync(jsonlFile);
		const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
		url.searchParams.set("visibility", "organization");
		url.searchParams.set("title", "Pi session");
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/x-ndjson",
				"Content-Length": String(body.byteLength),
			},
			body,
			signal,
		});
		if (signal.aborted) return { status: "cancelled" };
		const responseText = await readBoundedResponse(response, MAX_RADIUS_RESPONSE_BYTES);
		if (signal.aborted) return { status: "cancelled" };
		const payload = parseRadiusResponse(responseText);
		if (!response.ok || !payload?.artifact?.canonical_url) {
			return failed(`Failed to upload Radius artifact: ${payload?.error || response.statusText || response.status}`);
		}
		const artifactUrl = safeHttpsUrl(payload.artifact.canonical_url);
		return artifactUrl && !artifactUrl.includes(token)
			? { status: "uploaded", url: artifactUrl }
			: failed("Failed to upload Radius artifact: invalid artifact URL");
	} catch (error: unknown) {
		if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return { status: "cancelled" };
		return {
			status: "failed",
			message: safeMessage(`Failed to upload Radius artifact: ${errorMessage(error)}`, token),
		};
	}
}

async function runCommand(command: string, args: readonly string[], signal: AbortSignal): Promise<ProcessResult> {
	if (signal.aborted) return { code: null, stdout: "", stderr: "", aborted: true };
	return await new Promise<ProcessResult>((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
		} catch (error: unknown) {
			resolve({ code: null, stdout: "", stderr: "", error: asErrnoError(error), aborted: signal.aborted });
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const appendBounded = (current: string, chunk: Buffer): string => {
			const remaining = MAX_PROCESS_OUTPUT_BYTES - Buffer.byteLength(current, "utf8");
			if (remaining <= 0) return current;
			return current + chunk.subarray(0, remaining).toString("utf8");
		};
		const finish = (result: ProcessResult): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = (): void => {
			try {
				child.kill();
			} catch {
				// The process may already have exited.
			}
		};
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = appendBounded(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendBounded(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.once("error", (error: NodeJS.ErrnoException) =>
			finish({
				code: null,
				stdout,
				stderr,
				error,
				aborted: signal.aborted,
			}),
		);
		child.once("close", (code) => finish({ code, stdout, stderr, aborted: signal.aborted }));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error("Radius response exceeded the size limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function parseRadiusResponse(value: string): {
	readonly artifact?: { readonly canonical_url?: string };
	readonly error?: string;
} | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		const artifact =
			record.artifact !== null && typeof record.artifact === "object" && !Array.isArray(record.artifact)
				? (record.artifact as Record<string, unknown>)
				: undefined;
		return {
			...(artifact && typeof artifact.canonical_url === "string"
				? { artifact: { canonical_url: artifact.canonical_url } }
				: {}),
			...(typeof record.error === "string" ? { error: record.error } : {}),
		};
	} catch {
		return null;
	}
}

function parseGistUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		const segments = url.pathname.split("/").filter(Boolean);
		const id = segments.at(-1);
		if (url.protocol !== "https:" || url.hostname !== "gist.github.com" || !id || !/^[a-f0-9]{20,40}$/i.test(id)) {
			return undefined;
		}
		return `https://gist.github.com/${segments.map(encodeURIComponent).join("/")}`;
	} catch {
		return undefined;
	}
}

function safeHttpsUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

function asErrnoError(error: unknown): NodeJS.ErrnoException {
	return error instanceof Error ? (error as NodeJS.ErrnoException) : new Error("Failed to start command");
}

function safeMessage(value: string, secret?: string): string {
	const withoutSecret = secret ? value.split(secret).join("[redacted]") : value;
	return withoutSecret
		.replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/gu, "[redacted]")
		.replace(/\b(?:sk-(?:ant-)?|sk_|rk_)[A-Za-z0-9_-]{16,}\b/gu, "[redacted]")
		.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "[redacted]")
		.slice(0, 512);
}
