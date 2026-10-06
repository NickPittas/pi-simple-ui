import { type Container, type EditorComponent, hyperlink, type TUI } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	createShareTrailingEntries,
	exportSessionForShare,
	type NativeSessionShareOutcome,
	type NativeSessionShareProgressPhase,
	shareSessionNative,
} from "../../core/session-share.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { theme } from "./theme/theme.ts";

export { createShareTrailingEntries, exportSessionForShare };

interface SessionShareContext {
	session: AgentSession;
	ui: TUI;
	editorContainer: Container;
	editor: EditorComponent;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
}

const LOADER_MESSAGES: Readonly<Record<NativeSessionShareProgressPhase, string>> = Object.freeze({
	"exporting-jsonl": "Preparing session share...",
	"checking-radius-auth": "Checking Radius authentication...",
	"uploading-radius": "Uploading to Radius...",
	"checking-github-auth": "Checking GitHub CLI authentication...",
	"exporting-html": "Exporting session HTML...",
	"creating-gist": "Creating private gist...",
});

/** Interactive UI adapter for the shared native operation. */
export async function shareSession(context: SessionShareContext): Promise<void> {
	const controller = new AbortController();
	let loader: BorderedLoader | undefined;
	let lastPhase: NativeSessionShareProgressPhase | undefined;
	let restored = false;
	let cancelledByUser = false;
	const restore = (): void => {
		if (restored) return;
		restored = true;
		if (loader) restoreEditor(loader, context);
	};
	const cancel = (): void => {
		if (!controller.signal.aborted) {
			cancelledByUser = true;
			controller.abort();
			restore();
			context.showStatus("Share cancelled");
		}
	};
	const showLoader = (phase: NativeSessionShareProgressPhase): void => {
		if (controller.signal.aborted || restored) return;
		if (phase === lastPhase) return;
		lastPhase = phase;
		loader?.dispose();
		context.editorContainer.clear();
		loader = new BorderedLoader(context.ui, theme, LOADER_MESSAGES[phase]);
		loader.onAbort = cancel;
		context.editorContainer.addChild(loader);
		context.ui.setFocus(loader);
		context.ui.requestRender();
	};

	showLoader("exporting-jsonl");
	let outcome: NativeSessionShareOutcome;
	try {
		outcome = await shareSessionNative(context.session, {
			signal: controller.signal,
			htmlThemeName: theme.name,
			onProgress: ({ phase }) => showLoader(phase),
		});
	} catch (error: unknown) {
		restore();
		context.showError(`Failed to share session: ${error instanceof Error ? error.message : "Unknown error"}`);
		return;
	} finally {
		restore();
	}

	if (outcome.status === "cancelled") {
		if (!cancelledByUser) context.showStatus("Share cancelled");
		return;
	}
	if (outcome.status === "failed") {
		context.showError(outcome.message);
		return;
	}
	if (outcome.destination === "radius-organization") {
		context.showStatus(`Share URL: ${hyperlink(outcome.url, outcome.url)}`);
		return;
	}
	context.showStatus(
		`Share URL: ${hyperlink(outcome.url, outcome.url)}\nGist: ${hyperlink(outcome.gistUrl, outcome.gistUrl)}`,
	);
}

function restoreEditor(loader: BorderedLoader, context: SessionShareContext): void {
	loader.dispose();
	context.editorContainer.clear();
	context.editorContainer.addChild(context.editor);
	context.ui.setFocus(context.editor);
	context.ui.requestRender();
}
