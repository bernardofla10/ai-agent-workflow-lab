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
