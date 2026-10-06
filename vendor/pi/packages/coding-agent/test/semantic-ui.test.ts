import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import {
	resolveSemanticView,
	type SemanticView,
	type SemanticViewDefinition,
} from "../src/core/extensions/semantic-ui.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

function createDefinition<T>(cancelValue: T, create = vi.fn()) {
	return {
		id: "test.view",
		version: 1,
		actionIds: ["submit"],
		validateState: (value): value is { count: number } =>
			typeof value === "object" && value !== null && "count" in value && typeof value.count === "number",
		validateAction: (value): value is { type: "submit" } =>
			typeof value === "object" && value !== null && "type" in value && value.type === "submit",
		cancelValue,
		create,
	} satisfies SemanticViewDefinition<T, { count: number }, { type: "submit" }>;
}

describe("semantic view SDK seam", () => {
	it("binds opaque handles to the actual extension owner without allowing owner selection", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const firstDefinition = createDefinition("cancelled");
		const secondDefinition = createDefinition("second");
		let firstHandle!: SemanticView<string>;
		let secondHandle!: SemanticView<string>;

		const first = await loadExtensionFromFactory(
			(pi) => {
				firstHandle = pi.defineSemanticView(firstDefinition);
			},
			process.cwd(),
			eventBus,
			runtime,
			"/extensions/first.ts",
		);
		const second = await loadExtensionFromFactory(
			(pi) => {
				secondHandle = pi.defineSemanticView(secondDefinition);
			},
			process.cwd(),
			eventBus,
			runtime,
			"/extensions/second.ts",
		);

		const resolvedFirst = resolveSemanticView(firstHandle);
		const resolvedSecond = resolveSemanticView(secondHandle);
		expect(resolvedFirst.extensionPath).toBe(first.path);
		expect(resolvedFirst.sourceInfo).toBe(first.sourceInfo);
		expect(resolvedFirst.extensionRuntime).toBe(runtime);
		expect(resolvedSecond.extensionPath).toBe(second.path);
		expect(resolvedSecond.sourceInfo).toBe(second.sourceInfo);
		expect(resolvedSecond.extensionRuntime).toBe(runtime);
		expect(resolvedFirst.definition).toMatchObject({ id: "test.view", cancelValue: "cancelled" });
		expect(() => resolveSemanticView(Object.freeze({ extensionPath: "/forged" }) as never)).toThrow(/forged/i);
	});

	it("rejects handles from failed or invalidated extension activations", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		let failedHandle!: SemanticView<string>;
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					failedHandle = pi.defineSemanticView(createDefinition("cancelled"));
					throw new Error("factory failed");
				},
				process.cwd(),
				eventBus,
				runtime,
				"/extensions/failed.ts",
			),
		).rejects.toThrow("factory failed");
		expect(() => resolveSemanticView(failedHandle)).toThrow(/stale|active/i);

		let activeHandle!: SemanticView<string>;
		await loadExtensionFromFactory(
			(pi) => {
				activeHandle = pi.defineSemanticView(createDefinition("cancelled"));
			},
			process.cwd(),
			eventBus,
			runtime,
			"/extensions/active.ts",
		);
		const independentRuntime = createExtensionRuntime();
		let independentHandle!: SemanticView<string>;
		await loadExtensionFromFactory(
			(pi) => {
				independentHandle = pi.defineSemanticView(createDefinition("independent"));
			},
			process.cwd(),
			createEventBus(),
			independentRuntime,
			"/extensions/independent.ts",
		);
		expect(() => resolveSemanticView(activeHandle)).not.toThrow();
		runtime.invalidate("test runtime invalidation");
		expect(() => resolveSemanticView(activeHandle)).toThrow(/stale|active/i);
		expect(resolveSemanticView(independentHandle).extensionPath).toBe("/extensions/independent.ts");
		expect(resolveSemanticView(independentHandle).extensionRuntime).toBe(independentRuntime);
		independentRuntime.invalidate();
		expect(() => resolveSemanticView(independentHandle)).toThrow(/stale|active/i);
	});

	it("forwards custom factories, options, and native capability without creating a controller", async () => {
		const runtime = createExtensionRuntime();
		let handle!: SemanticView<string>;
		await loadExtensionFromFactory(
			(pi) => {
				handle = pi.defineSemanticView(createDefinition("cancelled"));
			},
			process.cwd(),
			createEventBus(),
			runtime,
			"/extensions/ui.ts",
		);

		const nativeCustom = vi.fn(async () => "completed");
		const supportsSemanticView = vi.fn((candidate: unknown) => candidate === handle);
		const nativeUI = { custom: nativeCustom, supportsSemanticView } as unknown as ExtensionUIContext;
		const runner = new ExtensionRunner(
			[],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		runner.setUIContext(nativeUI, "tui");

		const factory = () => ({ render: () => [], invalidate: vi.fn() });
		const options = { semantic: handle };
		const wrappedUI = runner.getUIContext();
		expect(wrappedUI.supportsSemanticView?.(handle)).toBe(true);
		await expect(wrappedUI.custom(factory, options)).resolves.toBe("completed");
		expect(nativeCustom).toHaveBeenCalledTimes(1);
		expect(nativeCustom.mock.calls[0]).toEqual([factory, options]);
		expect(resolveSemanticView(handle).definition.create).not.toHaveBeenCalled();
	});
});
