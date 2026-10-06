/**
 * workflow-menu.ts — `/agents → Workflows`, and the run inspector behind it.
 *
 * The same shape `schedule-menu.ts` has for `/agents → Scheduled jobs`: the
 * submenu and the overlay it opens live here, and everything they need arrives
 * as {@link WorkflowMenuDeps} rather than through a closure. The inspector is
 * reached from two places — this menu and a `workflow` row in the fleet list —
 * and both go through `showWorkflowDialog`, so the two entry points cannot
 * drift apart on what the keys do.
 *
 * Lives in the agents menu rather than as a top-level `/workflows` command: it
 * is one more view of the same fleet, and a second command name would only add
 * a collision surface (pi renames duplicate commands to `/workflows:1` and
 * `/workflows:2`, which breaks the bare name for both).
 */

import type { ExtensionCommandContext, JSONValue, SemanticView, SemanticViewDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";
import { extractMeta } from "../workflow/meta.js";
import { listSavedWorkflows, readSavedWorkflow } from "../workflow/saved.js";
import { pauseWorkflowTask, resumeWorkflowTask, type WorkflowTask } from "../workflow/task.js";
import { WorkflowDialog } from "./workflow-dialog.js";

type WorkflowMenuItem = {
  id: string;
  name: string;
  description?: string;
  stepCount?: number;
}

type SemanticWorkflowMenuState = {
  workflows: WorkflowMenuItem[];
  running: WorkflowMenuItem[];
}

type SemanticWorkflowMenuAction =
  | { type: "open"; workflowId: string }
  | { type: "run"; workflowId: string }
  | { type: "edit"; workflowId: string }
  | { type: "delete"; workflowId: string }
  | { type: "cancel"; workflowId?: string };

/** Everything the menu and the inspector need from the extension around them. */
export interface WorkflowMenuDeps {
  /**
   * Live runs by id, read on every use rather than snapshotted: a run that
   * settled and was swept between render and keypress must be a no-op, not a
   * crash.
   */
  tasks: ReadonlyMap<string, WorkflowTask>;
  /** The record behind an agent id, or undefined once it has been swept. */
  getRecord(id: string): AgentRecord | undefined;
  /** The conversation overlay `c` opens on an agent row. */
  viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord): Promise<void>;
  /**
   * The session context, for the fleet-list entry point — that one is a
   * keypress in a list that holds no `ctx` of its own. Undefined between
   * sessions, which is a no-op rather than an error.
   */
  getCtx(): ExtensionCommandContext | undefined;
  /** Change notifications are additive; workflow progress remains owned by the task map. */
  subscribe?(listener: () => void): () => void;
  notifyChanged?(): void;
  defineSemanticView?<T, State extends JSONValue, Action extends JSONValue>(
    definition: SemanticViewDefinition<T, State, Action>,
  ): SemanticView<T>;
}

function cancelWorkflowTask(ctx: ExtensionCommandContext, task: WorkflowTask, deps: WorkflowMenuDeps): void {
  if (task.abortController.signal.aborted) return;
  task.abortController.abort();
  deps.notifyChanged?.();
  ctx.ui.notify(`Stopped workflow "${task.meta?.name ?? task.id}".`, "info");
}

/**
 * Open the inspector for a workflow run.
 *
 * All six controls are wired: `onKill` aborts the run's controller, while
 * pause/resume and per-agent skip/retry go through `task.control`, the handle
 * `runWorkflow` hands back. `onOpenAgent` is the odd one out — it opens the
 * child's conversation rather than changing the run. The dialog derives its key
 * hints from the actions it is handed, so the footer advertises exactly what
 * works — see `WorkflowDialogActions`.
 */
export async function showWorkflowDialog(
  ctx: ExtensionCommandContext,
  task: WorkflowTask,
  deps: WorkflowMenuDeps,
): Promise<void> {
  // Overlaid on the same terms as the conversation viewer, because they are
  // reached the same way: both are rows of the fleet list, and opening one
  // must not behave unlike opening the other. Inline, the frame would render
  // into the conversation and stay in the scrollback after it closed.
  const { VIEWPORT_HEIGHT_PCT } = await import("./conversation-viewer.js");
  /**
   * This dialog's own overlay, so `c` can hide it while the conversation is
   * up. Overlays stack, so the viewer would render *over* it either way —
   * but the two frames size themselves to different content, and the taller
   * one's edges show around the shorter. Hidden, there is nothing to peek
   * out, and un-hiding puts the focus back on the dialog when the viewer
   * closes.
   */
  let overlay: { setHidden(hidden: boolean): void } | undefined;
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) =>
      new WorkflowDialog(
        tui,
        // Re-read on every render: the run is in the background, so the
        // dialog has to follow it rather than snapshot it at open time.
        () => ({
          progress: task.workflowProgress,
          task: {
            status: task.status,
            workflowName: task.workflowName,
            startTime: task.startTime,
            endTime: task.endTime,
            totalPausedMs: task.totalPausedMs,
          },
          meta: task.meta,
          agentCount: task.agentCount,
        }),
        theme,
        done,
        {
          onKill: () => {
            cancelWorkflowTask(ctx, task, deps);
          },
          onPause: () => {
            if (pauseWorkflowTask(task)) {
              deps.notifyChanged?.();
              // Named rather than implied: "paused" on a run whose agents are
              // still finishing reads as a stronger promise than it is.
              ctx.ui.notify("Paused — running agents finish, no new ones start.", "info");
            }
          },
          onResume: () => {
            if (resumeWorkflowTask(task)) {
              deps.notifyChanged?.();
              ctx.ui.notify("Resumed.", "info");
            }
          },
          onSkipAgent: index => {
            if (task.control?.skip(index) !== true) {
              ctx.ui.notify("Nothing to skip — that agent has already finished.", "info");
            }
          },
          onRetryAgent: index => {
            if (task.control?.retry(index) !== true) {
              // The window is exactly "while it is running": before that
              // there is nothing to stop, after it the script has its answer.
              ctx.ui.notify("Only a running agent can be retried.", "info");
            }
          },
          onOpenAgent: recordId => {
            const record = deps.getRecord(recordId);
            // A run's children are records like any other, so they are swept
            // ten minutes after they finish — the row outlives the
            // conversation it points at, and saying why beats an overlay that
            // opens empty.
            if (record === undefined) {
              ctx.ui.notify("No conversation left — agent records are dropped ten minutes after they finish.", "info");
              return;
            }
            overlay?.setHidden(true);
            // Caught before the `finally`, so a viewer that fails to open
            // still un-hides the dialog and cannot surface as an unhandled
            // rejection out of a detached promise.
            void deps.viewAgentConversation(ctx, record)
              .catch(err => ctx.ui.notify(
                `Could not open the conversation: ${err instanceof Error ? err.message : String(err)}`,
                "warning",
              ))
              .finally(() => overlay?.setHidden(false));
          },
        },
      ),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      onHandle: handle => { overlay = handle; },
    },
  );
}

/**
 * Open a run from the fleet list.
 *
 * The list hands back an id rather than a task, so a run that settled and was
 * swept between render and keypress is a no-op instead of a crash. `esc` in the
 * dialog closes it and control returns to the list — which is why the promise
 * is handed back: the list puts the cursor back on the run rather than dropping
 * the reader at `main`.
 */
export function openWorkflowFromFleet(id: string, deps: WorkflowMenuDeps): Promise<void> | void {
  const task = deps.tasks.get(id);
  const ctx = deps.getCtx();
  if (task === undefined || ctx === undefined) return;
  return showWorkflowDialog(ctx, task, deps);
}

/** `/agents → Workflows` — list this session's runs, open one. */
export async function showWorkflowsMenu(
  ctx: ExtensionCommandContext,
  deps: WorkflowMenuDeps,
): Promise<void> {
  const semantic = deps.defineSemanticView?.(createSemanticWorkflowMenuDefinition(ctx, deps));
  if (semantic !== undefined && ctx.ui.supportsSemanticView?.(semantic) === true) {
    await ctx.ui.custom<void>(
      () => ({ render: () => [], invalidate: () => {} }),
      { semantic },
    );
    return;
  }

  const tasks = [...deps.tasks.values()].sort((a, b) => b.startTime - a.startTime);
  if (tasks.length === 0) {
    ctx.ui.notify("No workflows in this session.", "info");
    return;
  }
  if (tasks.length === 1) {
    await showWorkflowDialog(ctx, tasks[0], deps);
    return;
  }
  // More than one: pick first. Newest at the top, since that is almost
  // always the one being asked about. `select` deals in plain strings and
  // hands back the string, so the label has to be unique or `indexOf` maps
  // the second run of a workflow onto the first — the run id makes it so.
  const labels = tasks.map(
    task =>
      `${task.meta?.name ?? task.id} — ${task.status}, ${task.agentCount} agent${
        task.agentCount === 1 ? "" : "s"
      } · ${task.id}`,
  );
  const picked = await ctx.ui.select("Workflows", labels);
  const index = picked !== undefined ? labels.indexOf(picked) : -1;
  if (index >= 0) await showWorkflowDialog(ctx, tasks[index], deps);
}

function createSemanticWorkflowMenuDefinition(
  ctx: ExtensionCommandContext,
  deps: WorkflowMenuDeps,
): SemanticViewDefinition<void, SemanticWorkflowMenuState, SemanticWorkflowMenuAction> {
  const isRecord = (value: JSONValue): value is { [key: string]: JSONValue } =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const savedWorkflows = (): WorkflowMenuItem[] => listSavedWorkflows(ctx.cwd).flatMap(name => {
    const resolved = readSavedWorkflow(name, ctx.cwd);
    if (!resolved.ok) return [];
    try {
      const meta = extractMeta(resolved.script).meta;
      return [{
        id: name,
        name: meta.name,
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.phases !== undefined ? { stepCount: meta.phases.length } : {}),
      }];
    } catch {
      return [];
    }
  });
  const snapshot = (): SemanticWorkflowMenuState => ({
    workflows: savedWorkflows(),
    running: [...deps.tasks.values()]
      .filter(task => task.status === "running" || task.status === "paused")
      .sort((a, b) => b.startTime - a.startTime)
      .map(task => ({
        id: task.id,
        name: task.meta?.name ?? task.workflowName ?? task.id,
        ...(task.meta?.description ? { description: task.meta.description } : {}),
        ...(task.meta?.phases !== undefined ? { stepCount: task.meta.phases.length } : {}),
      })),
  });
  const isItem = (value: JSONValue): value is WorkflowMenuItem =>
    isRecord(value) &&
    Object.keys(value).every(key => ["id", "name", "description", "stepCount"].includes(key)) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.stepCount === undefined || (typeof value.stepCount === "number" && Number.isInteger(value.stepCount)));
  const isState = (value: JSONValue): value is SemanticWorkflowMenuState =>
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.workflows) && value.workflows.every(isItem) &&
    Array.isArray(value.running) && value.running.every(isItem);
  const isAction = (value: JSONValue): value is SemanticWorkflowMenuAction => {
    if (!isRecord(value) || typeof value.type !== "string") return false;
    const state = snapshot();
    if (value.type === "cancel") {
      return Object.keys(value).length === 1 || (
        Object.keys(value).length === 2 &&
        typeof value.workflowId === "string" &&
        (() => {
          const task = deps.tasks.get(value.workflowId as string);
          return task !== undefined && (task.status === "running" || task.status === "paused");
        })()
      );
    }
    if (Object.keys(value).length !== 2 || typeof value.workflowId !== "string") return false;
    if (value.type === "open") {
      return deps.tasks.has(value.workflowId) || state.workflows.some(workflow => workflow.id === value.workflowId);
    }
    if (value.type === "run" || value.type === "edit" || value.type === "delete") {
      return state.workflows.some(workflow => workflow.id === value.workflowId);
    }
    return false;
  };

  return {
    id: "pi-subagents.workflows",
    version: 1,
    actionIds: ["open", "run", "edit", "delete", "cancel"],
    validateState: isState,
    validateAction: isAction,
    cancelValue: undefined,
    create: ({ done, signal }) => {
      let disposed = false;
      let completed = false;
      let busy = false;
      const listeners = new Set<() => void>();
      const notify = () => { for (const listener of listeners) listener(); };
      const finish = () => {
        if (disposed || completed) return;
        completed = true;
        signal.removeEventListener("abort", onAbort);
        done(undefined);
      };
      const onAbort = () => finish();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      const unsubscribe = deps.subscribe?.(notify);

      return {
        snapshot,
        subscribe(listener) {
          if (disposed) return () => {};
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispatch(action) {
          if (disposed || completed || busy || !isAction(action)) return;
          if (action.type === "cancel" && action.workflowId === undefined) {
            finish();
            return;
          }
          if (action.type === "cancel") {
            const task = deps.tasks.get(action.workflowId!);
            if (!task || task.abortController.signal.aborted || (task.status !== "running" && task.status !== "paused")) return;
            cancelWorkflowTask(ctx, task, deps);
            notify();
            return;
          }
          if (action.type === "open") {
            const saved = snapshot().workflows.find(workflow => workflow.id === action.workflowId);
            const task = deps.tasks.get(action.workflowId) ?? (saved === undefined
              ? undefined
              : [...deps.tasks.values()]
                .filter(candidate => candidate.meta?.name === saved.name || candidate.workflowName === saved.name)
                .sort((a, b) => b.startTime - a.startTime)[0]);
            if (!task) {
              ctx.ui.notify("No workflow run is available to open from the native inspector.", "info");
              return;
            }
            busy = true;
            void Promise.resolve(openWorkflowFromFleet(task.id, deps))
              .then(() => { busy = false; notify(); }, () => { busy = false; notify(); });
            return;
          }

          const verb = action.type;
          ctx.ui.notify(
            `Cannot ${verb} this saved workflow from the current native menu; no native ${verb} handler is available.`,
            "warning",
          );
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          signal.removeEventListener("abort", onAbort);
          unsubscribe?.();
          listeners.clear();
        },
      };
    },
  } satisfies SemanticViewDefinition<void, SemanticWorkflowMenuState, SemanticWorkflowMenuAction>;
}
