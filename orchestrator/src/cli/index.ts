import { DeliveryExecutor } from "../delivery/delivery-executor.js";
import { GitDelivery } from "../delivery/git-delivery.js";
import { GitHubDeliveryAdapter } from "../delivery/github-delivery.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { githubRepository, loadRuntimeEnvironment } from "../config/environment.js";
import { workflowFromEnvironment } from "../config/workflow.js";
import { CoordinatorRunner } from "../dispatch/coordinator-runner.js";
import { DispatchExecutor } from "../dispatch/dispatch-executor.js";
import { GitWaveBaseProvider } from "../integrations/git/wave-base.js";
import { GitHubSupervisionAdapter } from "../integrations/github/supervision-adapter.js";
import { maxConcurrencyFromEnvironment } from "../runtime/run-state.js";
import { StateStore } from "../runtime/state-store.js";
import { ReviewerRunner } from "../supervision/reviewer-runner.js";
import { Supervisor } from "../supervision/supervisor.js";
import { executeCommand, parseCommand } from "./runtime-cli.js";

try {
  const input = parseCommand(process.argv.slice(2));
  const root = resolve(input.values.root ?? fileURLToPath(new URL("../../../", import.meta.url)));
  loadRuntimeEnvironment(root);
  const concurrency = maxConcurrencyFromEnvironment();
  const store = new StateStore(root, concurrency);
  const executor = new DispatchExecutor(root, undefined, concurrency);
  const result = await executeCommand(input, {
    store, concurrency,
    readyTickets: async () => (await workflowFromEnvironment().getReadyTickets()).tickets,
    captureBaseCommit: () => new GitWaveBaseProvider(root).captureBaseCommit(),
    inspectBaseCommit: () => new GitWaveBaseProvider(root).inspectBaseCommit(),
    coordinator: new CoordinatorRunner(root),
    dispatch: (id) => executor.dispatch(id),
    preview: (id) => executor.preview(id),
    previewEphemeral: (run) => executor.previewEphemeral(run),
    deliver: (id) => {
      const repository = githubRepository();
      const github = new GitHubDeliveryAdapter(repository, root, new GitHubSupervisionAdapter(repository));
      return new DeliveryExecutor(store, new GitDelivery(root), github, repository).deliver(id);
    },
    supervise: (id) => {
      const repository = githubRepository();
      return new Supervisor(store, new GitHubSupervisionAdapter(repository), new ReviewerRunner(root), repository).supervise(id);
    },
    now: () => new Date(),
  });
  process.stdout.write(`${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Runtime command failed"}\n`);
  process.exitCode = 1;
}
