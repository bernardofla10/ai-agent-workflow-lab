import { lstat, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Ticket } from "../domain/ticket.js";
import { DispatchPlanner } from "../dispatch/dispatch-planner.js";
import { coordinatorDecisionSchema, validateDecision, type Coordinator } from "../dispatch/coordinator-runner.js";
import { parseRun } from "../runtime/run-state.js";
import { runIdSchema, type ExecutionRun } from "../runtime/types.js";
import type { StateStore } from "../runtime/state-store.js";

export const usage = `runtime <command> [--root PATH] [--run-id ID]
  plan [--persist | --coordinator codex | --approval-file FILE]
  preflight --run-id ID --approval-file FILE
  dispatch --dry-run
  dispatch --run-id ID [--dry-run]
  status [--run-id ID]
  deliver --run-id ID
  supervise --run-id ID

plan and dispatch --dry-run are ephemeral by default. plan --persist reserves a
planned run. preflight records manual semantic approval before real dispatch.
Preflight approval JSON: {runId,baseCommit,candidates,allowed}.
Legacy plan --approval-file accepts {baseCommit,candidates,allowed}.`;

const manualPreflightSchema = coordinatorDecisionSchema.extend({ runId: runIdSchema });

async function readApproval(file: string): Promise<unknown> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid manual Coordinator approval file");
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

export function parseCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    root: { type: "string" }, "run-id": { type: "string" }, "dry-run": { type: "boolean" },
    coordinator: { type: "string" }, "approval-file": { type: "string" }, persist: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) return { command: "help" as const, values };
  const command = positionals[0];
  if (positionals.length !== 1 || !["plan", "preflight", "dispatch", "status", "supervise", "deliver"].includes(command ?? "")) throw new Error(usage);
  if ((values["dry-run"] && command !== "dispatch") ||
    (values.coordinator && command !== "plan") ||
    (values["approval-file"] && command !== "plan" && command !== "preflight") ||
    (values.persist && (command !== "plan" || values.coordinator || values["approval-file"])) ||
    (values.coordinator && values.coordinator !== "codex") ||
    (values.coordinator && values["approval-file"])) throw new Error("Invalid options for runtime command");
  if (values["run-id"]) runIdSchema.parse(values["run-id"]);
  if ((command === "preflight" || command === "deliver" || command === "supervise" || (command === "dispatch" && !values["dry-run"])) &&
    !values["run-id"]) throw new Error("--run-id is required");
  if (command === "preflight" && !values["approval-file"]) throw new Error("--approval-file is required");
  return { command: command as "plan" | "preflight" | "dispatch" | "status" | "supervise" | "deliver", values };
}

export interface RuntimeDependencies {
  store: Pick<StateStore, "inspectAll" | "save">;
  concurrency: number;
  readyTickets(): Promise<readonly Ticket[]>;
  captureBaseCommit(): Promise<string>;
  inspectBaseCommit(): Promise<string>;
  coordinator: Coordinator;
  dispatch(runId: string): Promise<{ run: ExecutionRun }>;
  preview(runId: string): Promise<unknown>;
  previewEphemeral(run: ExecutionRun): Promise<unknown>;
  deliver(runId: string): Promise<ExecutionRun>;
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
  if (command === "preflight" || command === "deliver" || command === "supervise" || (command === "dispatch" && id)) {
    const run = existing.find((entry) => entry.id === id);
    if (!run) throw new Error("Persisted run not found");
    if (command === "deliver") return deps.deliver(run.id);
    if (command === "supervise") return deps.supervise(run.id);
    if (command === "preflight") {
      if (run.preflight) throw new Error("Recorded preflight is immutable");
      if (run.assignments.some((assignment) => assignment.status !== "planned")) throw new Error("Preflight requires an unchanged planned run");
      const { runId, ...decision } = manualPreflightSchema.parse(await readApproval(values["approval-file"]!));
      if (runId !== run.id) throw new Error("Preflight runId must match the persisted run");
      const approved = validateDecision(decision, run);
      const next = parseRun({ ...run, preflight: { kind: "manual", runId, ...approved } });
      await deps.store.save(next, run);
      return { persisted: true, preflightRequired: false, ...next };
    }
    if (!run.preflight) throw new Error("Dispatch requires persisted Coordinator preflight; legacy plans need human inspection");
    if (!values["dry-run"] && run.preflight.allowed.length === 0) throw new Error("Preflight approval is empty; no Workers started");
    return values["dry-run"] ? deps.preview(run.id) : (await deps.dispatch(run.id)).run;
  }
  const readyTickets = await deps.readyTickets(); // Existing deterministic DAG scheduler.
  const persist = Boolean(values.persist || values.coordinator || values["approval-file"]);
  const baseCommit = await (persist ? deps.captureBaseCommit() : deps.inspectBaseCommit());
  const now = deps.now();
  const planner = new DispatchPlanner(deps.concurrency);
  const planInput = { id: id ?? `run-${now.toISOString().replace(/[^0-9]/g, "")}`,
    createdAt: now.toISOString(), baseCommit, readyTickets, existingRuns: existing };
  const preview = planner.plan(planInput);
  const snapshot = { baseCommit, candidates: preview.candidates };
  if (command === "dispatch") return deps.previewEphemeral(preview);
  if (!values.coordinator && !values["approval-file"]) {
    if (values.persist) await deps.store.save(preview);
    return { persisted: persist, preflightRequired: true, concurrency: deps.concurrency,
      ...preview, approvalTemplate: { runId: preview.id, ...snapshot, allowed: [] } };
  }
  let decision: unknown;
  const file = values["approval-file"];
  if (file) {
    decision = await readApproval(file);
  } else decision = await deps.coordinator.decide(snapshot);
  const approved = validateDecision(decision, snapshot);
  const run = parseRun({
    ...planner.plan({ ...planInput, readyTickets: readyTickets.filter((ticket) => approved.allowed.includes(ticket.id)) }),
    candidates: preview.candidates,
    preflight: { kind: file ? "manual" : "codex", runId: preview.id, ...approved },
  });
  await deps.store.save(run);
  return { persisted: true, concurrency: deps.concurrency, ...run };
}
