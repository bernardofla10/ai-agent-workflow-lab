import { lstat, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Ticket } from "../domain/ticket.js";
import { DispatchPlanner } from "../dispatch/dispatch-planner.js";
import { validateDecision, type Coordinator } from "../dispatch/coordinator-runner.js";
import { parseRun } from "../runtime/run-state.js";
import { runIdSchema, type ExecutionRun } from "../runtime/types.js";
import type { StateStore } from "../runtime/state-store.js";

export const usage = `runtime <command> [--root PATH] [--run-id ID]
  plan [--coordinator codex | --approval-file FILE]
  dispatch --run-id ID [--dry-run]
  status [--run-id ID]
  supervise --run-id ID

plan previews by default. Explicit Coordinator preflight is required to persist
an authorized run. Manual approval JSON: {baseCommit,candidates,allowed}.`;

export function parseCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    root: { type: "string" }, "run-id": { type: "string" }, "dry-run": { type: "boolean" },
    coordinator: { type: "string" }, "approval-file": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) return { command: "help" as const, values };
  const command = positionals[0];
  if (positionals.length !== 1 || !["plan", "dispatch", "status", "supervise"].includes(command ?? "")) throw new Error(usage);
  if ((values["dry-run"] && command !== "dispatch") ||
    ((values.coordinator || values["approval-file"]) && command !== "plan") ||
    (values.coordinator && values.coordinator !== "codex") ||
    (values.coordinator && values["approval-file"])) throw new Error("Invalid options for runtime command");
  if (values["run-id"]) runIdSchema.parse(values["run-id"]);
  if (["dispatch", "supervise"].includes(command!) && !values["run-id"]) throw new Error("--run-id is required");
  return { command: command as "plan" | "dispatch" | "status" | "supervise", values };
}

export interface RuntimeDependencies {
  store: Pick<StateStore, "inspectAll" | "save">;
  concurrency: number;
  readyTickets(): Promise<readonly Ticket[]>;
  captureBaseCommit(): Promise<string>;
  coordinator: Coordinator;
  dispatch(runId: string): Promise<{ run: ExecutionRun }>;
  preview(runId: string): Promise<unknown>;
  supervise(runId: string): Promise<ExecutionRun>;
  now(): Date;
}

export async function executeCommand(input: ReturnType<typeof parseCommand>, deps: RuntimeDependencies): Promise<unknown> {
  const { command, values } = input;
  if (command === "help") return usage;
  const existing = await deps.store.inspectAll();
  const id = values["run-id"];
  if (command === "status") {
    if (!id) return existing;
    const run = existing.find((entry) => entry.id === id);
    if (!run) throw new Error("Persisted run not found");
    return run;
  }
  if (command === "dispatch" || command === "supervise") {
    const run = existing.find((entry) => entry.id === id);
    if (!run) throw new Error("Persisted run not found");
    if (command === "supervise") return deps.supervise(run.id);
    if (!run.preflight) throw new Error("Dispatch requires persisted Coordinator preflight; legacy plans need human inspection");
    return values["dry-run"] ? deps.preview(run.id) : (await deps.dispatch(run.id)).run;
  }
  const readyTickets = await deps.readyTickets(); // Existing deterministic DAG scheduler.
  const baseCommit = await deps.captureBaseCommit();
  const now = deps.now();
  const planner = new DispatchPlanner(deps.concurrency);
  const planInput = { id: id ?? `run-${now.toISOString().replace(/[^0-9]/g, "")}`,
    createdAt: now.toISOString(), baseCommit, readyTickets, existingRuns: existing };
  const preview = planner.plan(planInput);
  const snapshot = { baseCommit, candidates: preview.candidates };
  if (!values.coordinator && !values["approval-file"]) {
    return { persisted: false, preflightRequired: true, concurrency: deps.concurrency,
      ...preview, approvalTemplate: { ...snapshot, allowed: [] } };
  }
  let decision: unknown;
  const file = values["approval-file"];
  if (file) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid manual Coordinator approval file");
    decision = JSON.parse(await readFile(file, "utf8")) as unknown;
  } else decision = await deps.coordinator.decide(snapshot);
  const approved = validateDecision(decision, snapshot);
  const run = parseRun({
    ...planner.plan({ ...planInput, readyTickets: readyTickets.filter((ticket) => approved.allowed.includes(ticket.id)) }),
    candidates: preview.candidates,
    preflight: { kind: file ? "manual" : "codex", ...approved },
  });
  await deps.store.save(run);
  return { persisted: true, concurrency: deps.concurrency, ...run };
}
