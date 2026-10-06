import type { JsonValue } from "@earendil-works/pi-ai";
import type { SourceInfo } from "../source-info.ts";

/** JSON data supported by semantic view state and actions. */
export type JSONValue = JsonValue;

const semanticViewBrand: unique symbol = Symbol("SemanticView");

/** Opaque handle issued by ExtensionAPI.defineSemanticView(). */
export interface SemanticView<T> {
	readonly [semanticViewBrand]: T;
}

export interface SemanticViewController<State extends JSONValue, Action extends JSONValue> {
	snapshot(): State;
	subscribe(listener: () => void): () => void;
	dispatch(action: Action): void;
	dispose?(): void;
}

export interface SemanticViewDefinition<T, State extends JSONValue, Action extends JSONValue> {
	id: string;
	version: number;
	actionIds: readonly string[];
	validateState(value: JSONValue): value is State;
	validateAction(value: JSONValue): value is Action;
	cancelValue: T;
	create(options: { done(value: T): void; signal: AbortSignal }): SemanticViewController<State, Action>;
}

/** Native-only result of resolving an opaque handle. Do not send this over an IPC boundary. */
export interface ResolvedSemanticView<T> {
	readonly extensionPath: string;
	readonly sourceInfo: SourceInfo;
	/** Exact native ExtensionRuntime that issued this handle; never expose over IPC. */
	readonly extensionRuntime: object;
	readonly definition: SemanticViewDefinition<T, JSONValue, JSONValue>;
}

interface SemanticViewActivation {
	active: boolean;
}

interface SemanticViewRecord<T> {
	definition: SemanticViewDefinition<T, JSONValue, JSONValue>;
	owner: { extensionPath: string; sourceInfo: SourceInfo };
	extensionRuntime: object;
	activation: SemanticViewActivation;
}

const semanticViews = new WeakMap<object, SemanticViewRecord<unknown>>();

/** @internal Constructed only by the extension loader to bind handles to their registering extension. */
export function createSemanticViewActivation(
	extensionPath: string,
	sourceInfo: SourceInfo,
	extensionRuntime: object,
): {
	define<T, State extends JSONValue, Action extends JSONValue>(
		definition: SemanticViewDefinition<T, State, Action>,
	): SemanticView<T>;
	activate(): void;
	revoke(): void;
} {
	const activation: SemanticViewActivation = { active: false };
	let revoked = false;

	return {
		define<T, State extends JSONValue, Action extends JSONValue>(
			definition: SemanticViewDefinition<T, State, Action>,
		) {
			if (revoked)
				throw new Error(`Extension "${extensionPath}" is no longer active and cannot define semantic views.`);
			if (!definition || typeof definition !== "object") {
				throw new TypeError("A semantic view definition must be an object.");
			}
			if (typeof definition.id !== "string" || definition.id.length === 0) {
				throw new TypeError("A semantic view definition must have a non-empty id.");
			}
			if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
				throw new TypeError(`Semantic view "${definition.id}" must have a positive integer version.`);
			}
			if (
				!Array.isArray(definition.actionIds) ||
				definition.actionIds.some((id) => typeof id !== "string" || id.length === 0) ||
				new Set(definition.actionIds).size !== definition.actionIds.length
			) {
				throw new TypeError(`Semantic view "${definition.id}" must have unique, non-empty actionIds.`);
			}
			if (
				typeof definition.validateState !== "function" ||
				typeof definition.validateAction !== "function" ||
				typeof definition.create !== "function"
			) {
				throw new TypeError(`Semantic view "${definition.id}" is missing a validator or create() function.`);
			}

			const issuedHandle = Object.freeze(Object.create(null)) as SemanticView<T>;
			const storedDefinition = Object.freeze({
				...definition,
				actionIds: Object.freeze([...definition.actionIds]),
			}) as SemanticViewDefinition<T, JSONValue, JSONValue>;
			semanticViews.set(issuedHandle, {
				definition: storedDefinition,
				owner: { extensionPath, sourceInfo },
				extensionRuntime,
				activation,
			});
			return issuedHandle;
		},
		activate() {
			if (!revoked) activation.active = true;
		},
		revoke() {
			revoked = true;
			activation.active = false;
		},
	};
}

/** Resolve an opaque handle for the native host; forged and stale handles are rejected. */
export function resolveSemanticView<T>(handle: SemanticView<T>): ResolvedSemanticView<T> {
	if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
		throw new TypeError("Invalid semantic view handle.");
	}
	const record = semanticViews.get(handle as object);
	if (!record) throw new TypeError("Invalid or forged semantic view handle.");
	if (!record.activation.active) throw new Error("Semantic view handle is stale or its extension is not active.");
	return {
		...record.owner,
		extensionRuntime: record.extensionRuntime,
		definition: record.definition,
	} as ResolvedSemanticView<T>;
}
