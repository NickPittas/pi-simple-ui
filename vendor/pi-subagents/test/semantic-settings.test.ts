import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	createEventBus,
	discoverAndLoadExtensions,
	ExtensionRunner,
	type ExtensionUIContext,
	getAgentDir,
	initTheme,
	type KeybindingsManager,
	type ModelRegistry,
	resolveSemanticView,
	type SemanticView,
	SessionManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Hermetic, hermeticDir } from "./helpers/boot-extension.js";

const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

describe("/agents → semantic Settings", () => {
	let hermetic: Hermetic;

	beforeEach(() => {
		hermetic = hermeticDir({ settings: { maxConcurrent: 3, agentMentions: "model" } });
		initTheme();
	});

	afterEach(() => hermetic.restore());

	it("applies enum actions and continues the native numeric input flow; TUI keeps the component factory", async () => {
		const loaded = await discoverAndLoadExtensions(
			[extensionPath],
			process.cwd(),
			getAgentDir(),
			createEventBus(),
		);
		expect(loaded.errors).toEqual([]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			SessionManager.inMemory(),
			{} as ModelRegistry,
		);
		let currentSettings = 0;
		const inputs: Array<{ title: string; prefill: string | undefined }> = [];
		const customResults: Array<string | undefined> = [];
		let subscriberCalls = 0;

		const semanticUI = {
			select: vi.fn(async (_title: string, options: string[]) => {
				expect(options).toContain("Settings");
				return currentSettings++ === 0 ? "Settings" : undefined;
			}),
			input: vi.fn(async (title: string, prefill?: string) => {
				inputs.push({ title, prefill });
				return inputs.length === 1 ? "not a number" : "7";
			}),
			notify: vi.fn(),
			custom: vi.fn(async (...args: unknown[]) => {
				const options = args[1] as { semantic?: SemanticView<string | undefined> } | undefined;
				if (!options?.semantic) throw new Error("Settings did not provide its semantic handle");
				const resolved = resolveSemanticView(options.semantic);
				expect(resolved.extensionPath).toBe(extensionPath);
				let result!: string | undefined;
				let complete!: (value: string | undefined) => void;
				const completed = new Promise<string | undefined>((resolve) => {
					complete = (value) => {
						result = value;
						resolve(value);
					};
				});
				const controller = resolved.definition.create({ done: complete, signal: new AbortController().signal });
				const state = controller.snapshot() as {
					title?: unknown;
					items?: Array<{ id: string; currentValue: string; values?: string[] }>;
				};
				if (!resolved.definition.validateState(controller.snapshot())) {
					throw new Error("Settings semantic snapshot failed its validator");
				}
				if (state.title !== "Subagent Settings" || !state.items) {
					throw new Error("Settings semantic snapshot is missing its native items");
				}
				const maxConcurrent = state.items.find((item) => item.id === "maxConcurrent");
				const mentions = state.items.find((item) => item.id === "agentMentions");
				expect({
					id: resolved.definition.id,
					actionIds: resolved.definition.actionIds,
					stateKeys: Object.keys(state).sort(),
					stateIsJson: JSON.stringify(controller.snapshot()) !== undefined,
					stateIsValid: resolved.definition.validateState(controller.snapshot()),
					maxConcurrent: maxConcurrent?.currentValue,
					mentions: mentions?.values,
					acceptsOption: resolved.definition.validateAction({ type: "set", id: "agentMentions", value: "direct" }),
					rejectsUnknownOption: resolved.definition.validateAction({ type: "set", id: "agentMentions", value: "invalid" }),
					rejectsExtraActionField: resolved.definition.validateAction({ type: "set", id: "agentMentions", value: "direct", extra: true }),
					rejectsExtraCancelField: resolved.definition.validateAction({ type: "cancel", extra: true }),
					rejectsExtraStateField: !resolved.definition.validateState({ ...controller.snapshot(), secret: "not-for-ui" }),
				}).toEqual({
					id: "pi-subagents.settings",
					actionIds: ["set", "edit", "cancel"],
					stateKeys: ["items", "title"],
					stateIsJson: true,
					stateIsValid: true,
					maxConcurrent: customResults.length === 0 ? "4" : "7",
					mentions: ["model", "direct", "off"],
					acceptsOption: true,
					rejectsUnknownOption: false,
					rejectsExtraActionField: false,
					rejectsExtraCancelField: false,
					rejectsExtraStateField: true,
				});
				const unsubscribe = controller.subscribe(() => subscriberCalls++);
				if (customResults.length === 0) {
					controller.dispatch({ type: "set", id: "agentMentions", value: "direct" });
					expect((controller.snapshot() as typeof state).items?.find((item) => item.id === "agentMentions")?.currentValue)
						.toBe("direct");
					controller.dispatch({ type: "edit", fieldId: "maxConcurrent" });
				} else {
					controller.dispatch({ type: "cancel" });
				}
				await completed;
				customResults.push(result);
				controller.dispose?.();
				unsubscribe();
				return result;
			}),
		} as unknown as ExtensionUIContext;

		runner.setUIContext(semanticUI, "tui");
		// Simulate an edit made outside pi after extension activation. The top-level
		// Settings invocation must reload it; the later numeric reopen must not.
		writeFileSync(
			`${hermetic.dir}/.pi/subagents.json`,
			JSON.stringify({ maxConcurrent: 4, agentMentions: "model" }),
		);
		const command = runner.getCommand("agents");
		if (!command) throw new Error("SDK runner did not register /agents");
		await command.handler("", runner.createCommandContext());

		expect(semanticUI.custom).toHaveBeenCalledTimes(2);
		expect(subscriberCalls).toBe(1);
		expect(customResults).toEqual(["maxConcurrent", undefined]);
		expect(inputs).toEqual([
			{ title: "Max concurrency (1+)", prefill: "4" },
			{ title: "Max concurrency (1+)", prefill: "not a number" },
		]);
		const persisted = JSON.parse(readFileSync(`${hermetic.dir}/.pi/subagents.json`, "utf-8")) as {
			maxConcurrent?: number;
			agentMentions?: string;
		};
		expect(persisted).toMatchObject({ maxConcurrent: 7, agentMentions: "direct" });

		// A native TUI context receives the same producer factory and handles
		// cancellation through its existing done(undefined) path; it does not resolve
		// or instantiate the semantic definition.
		let tuiMenuCalls = 0;
		const tuiUI = {
			select: vi.fn(async () => tuiMenuCalls++ === 0 ? "Settings" : undefined),
			input: vi.fn(async () => undefined),
			notify: vi.fn(),
			custom: vi.fn(async (factory: unknown, options: unknown) => {
				const semanticOptions = options as { semantic?: SemanticView<string | undefined> } | undefined;
				if (!semanticOptions?.semantic || typeof factory !== "function") {
					throw new Error("TUI did not receive the original semantic custom options");
				}
				const customFactory = factory as Parameters<ExtensionUIContext["custom"]>[0];
				let finish!: (value: unknown) => void;
				const completed = new Promise<unknown>((resolve) => { finish = resolve; });
				const component = await customFactory(
					{ requestRender: vi.fn() } as unknown as TUI,
					{} as Theme,
					{} as KeybindingsManager,
					finish,
				) as Component;
				expect(component.render(80).join("\n")).toContain("Subagent Settings");
				component.handleInput?.("\x1b");
				return completed;
			}),
		} as unknown as ExtensionUIContext;
		runner.setUIContext(tuiUI, "tui");
		await command.handler("", runner.createCommandContext());
		expect(tuiUI.custom).toHaveBeenCalledTimes(1);
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
	});

	it("keeps a session-only numeric edit when persistence fails during the native reopen", async () => {
		const loaded = await discoverAndLoadExtensions(
			[extensionPath],
			process.cwd(),
			getAgentDir(),
			createEventBus(),
		);
		expect(loaded.errors).toEqual([]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			SessionManager.inMemory(),
			{} as ModelRegistry,
		);
		let menuCall = 0;
		let customCall = 0;
		let inputCall = 0;
		const numericValues: string[] = [];
		const settingsPath = `${hermetic.dir}/.pi/subagents.json`;
		const ui = {
			select: vi.fn(async () => menuCall++ === 0 ? "Settings" : undefined),
			input: vi.fn(async (_title: string, prefill?: string) => {
				expect(prefill).toBe(inputCall === 0 ? "3" : "not a number");
				return inputCall++ === 0 ? "not a number" : "9";
			}),
			notify: vi.fn(),
			custom: vi.fn(async (...args: unknown[]) => {
				const options = args[1] as { semantic?: SemanticView<string | undefined> } | undefined;
				if (!options?.semantic) throw new Error("Settings did not provide its semantic handle");
				const { definition } = resolveSemanticView(options.semantic);
				let complete!: (value: string | undefined) => void;
				const completed = new Promise<string | undefined>((resolve) => { complete = resolve; });
				const controller = definition.create({
					done: complete,
					signal: new AbortController().signal,
				});
				const numeric = (controller.snapshot() as { items: Array<{ id: string; currentValue: string }> })
					.items.find((item) => item.id === "maxConcurrent");
				if (!numeric) throw new Error("Missing native maxConcurrent setting");
				numericValues.push(numeric.currentValue);
				if (customCall++ === 0) {
					controller.dispatch({ type: "edit", fieldId: "maxConcurrent" });
					// Make the real project target unwritable for the subsequent numeric
					// applyValue save. The in-memory value must survive the menu reopen.
					unlinkSync(settingsPath);
					mkdirSync(settingsPath);
				} else {
					controller.dispatch({ type: "cancel" });
				}
				const result = await completed;
				controller.dispose?.();
				return result;
			}),
		} as unknown as ExtensionUIContext;

		runner.setUIContext(ui, "tui");
		const command = runner.getCommand("agents");
		if (!command) throw new Error("SDK runner did not register /agents");
		await command.handler("", runner.createCommandContext());

		expect(numericValues).toEqual(["3", "9"]);
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("session only; failed to persist"), "warning");
		expect(ui.custom).toHaveBeenCalledTimes(2);
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
	});
});
