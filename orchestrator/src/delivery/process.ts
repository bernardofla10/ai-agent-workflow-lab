import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type DeliveryProcess = (file: string, args: string[], cwd: string) => Promise<string>;
const execute = promisify(execFile);

export const runDeliveryProcess: DeliveryProcess = async (file, args, cwd) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    const result = await execute(file, args, {
      cwd, shell: false, env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GH_PROMPT_DISABLED: "1" },
      encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout;
  } catch {
    // execFile rejects nonzero exits, signals, timeouts and output overflow.
    // Do not persist subprocess output: it may contain credentials.
    throw new Error(`Delivery ${file} operation failed; inspect locally before resuming`);
  }
};
