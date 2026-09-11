import { lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { maxConcurrency, parseRun, parseRuns, reservesTicket } from "./run-state.js";
import { runIdSchema, type ExecutionRun } from "./types.js";

export class StateStore {
  private readonly runtimeDirectory: string;
  private readonly directory: string;
  private readonly limit: number;

  constructor(repositoryRoot: string, concurrency = 2) {
    this.runtimeDirectory = resolve(repositoryRoot, ".ai-workflow");
    this.directory = join(this.runtimeDirectory, "runs");
    this.limit = maxConcurrency(concurrency);
  }

  private async ensureDirectory(path: string): Promise<void> {
    try { await mkdir(path, { mode: 0o700 }); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    if (!(await lstat(path)).isDirectory()) throw new Error("Runtime path must be a real directory");
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory(this.runtimeDirectory);
    await this.ensureDirectory(this.directory);
    const lockPath = join(this.directory, ".lock");
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); } catch {
      throw new Error("Runtime store locked or inaccessible; do not dispatch until resolved");
    }
    try {
      return await operation();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  private async readRuns(): Promise<ExecutionRun[]> {
    const entries = (await readdir(this.directory)).filter((name) => name !== ".lock").sort();
    const runs: ExecutionRun[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) throw new Error("Unexpected runtime file; recovery required");
      const id = runIdSchema.parse(name.slice(0, -5));
      const path = join(this.directory, name);
      if (!(await lstat(path)).isFile()) throw new Error("Runtime state must be a regular file");
      let run: ExecutionRun;
      try { run = parseRun(JSON.parse(await readFile(path, "utf8"))); } catch {
        throw new Error(`Invalid runtime state: ${id}`);
      }
      if (run.id !== id) throw new Error("Runtime filename and run ID differ");
      runs.push(run);
    }
    return parseRuns(runs);
  }

  loadAll(): Promise<ExecutionRun[]> {
    return this.locked(() => this.readRuns());
  }

  async load(id: string): Promise<ExecutionRun> {
    runIdSchema.parse(id);
    const run = (await this.loadAll()).find((run) => run.id === id);
    if (!run) throw new Error(`Run not found: ${id}`);
    return run;
  }

  // Omit expected only for creation. Updates compare the complete loaded snapshot
  // while holding the same repository-local lock used for cross-run reservations.
  async save(value: ExecutionRun, expected?: ExecutionRun): Promise<void> {
    const run = parseRun(value);
    const previous = expected === undefined ? undefined : parseRun(expected);
    await this.locked(async () => {
      const runs = await this.readRuns();
      const current = runs.find((entry) => entry.id === run.id);
      if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error("Stale or existing run; reload before saving");
      if (current) {
        const metadata = (entry: ExecutionRun) => ({ ...entry, assignments: [] });
        if (JSON.stringify(metadata(current)) !== JSON.stringify(metadata(run))) {
          throw new Error("Run metadata and wave base are immutable");
        }
        for (const old of current.assignments) {
          const next = run.assignments.find((assignment) => assignment.ticketId === old.ticketId);
          if (!next || next.branch !== old.branch || next.worktreePath !== old.worktreePath ||
            (old.status === "merged" && next.status !== "merged")) {
            throw new Error("Cannot remove, reroute or reactivate an assignment");
          }
        }
      }
      const added = run.assignments.filter((assignment) =>
        !current?.assignments.some((old) => old.ticketId === assignment.ticketId));
      if (added.some((assignment) => assignment.status !== "planned")) {
        throw new Error("New assignments must be planned");
      }
      const nextRuns = parseRuns([...runs.filter((entry) => entry.id !== run.id), run]);
      const count = (entries: ExecutionRun[]) => entries.flatMap((entry) => entry.assignments.filter(reservesTicket)).length;
      if (count(nextRuns) > this.limit && count(nextRuns) > count(runs)) {
        throw new Error("MAX_CONCURRENCY exceeded; reload and replan");
      }
      const temporary = join(this.directory, `${run.id}.tmp`);
      const destination = join(this.directory, `${run.id}.json`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(run, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      // A leftover temp file after interruption fails closed on the next load.
      await rename(temporary, destination);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    });
  }
}
