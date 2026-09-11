import { join } from "node:path";
import { loadEnvFile } from "node:process";

export function loadRuntimeEnvironment(repositoryRoot: string): void {
  // Node preserves existing variables: shell > root .env > orchestrator/.env.
  for (const path of [join(repositoryRoot, ".env"), join(repositoryRoot, "orchestrator", ".env")]) {
    try { loadEnvFile(path); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw new Error("Unable to load runtime environment file; check local file access");
    }
  }
}

export function requiredEnvironment(name: string, env = process.env): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function githubRepository(env = process.env): string {
  const value = requiredEnvironment("GITHUB_REPOSITORY", env);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("GITHUB_REPOSITORY must use owner/repository format");
  }
  return value;
}
