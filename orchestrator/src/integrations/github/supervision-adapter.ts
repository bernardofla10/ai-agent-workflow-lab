import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { githubRepository } from "../../config/environment.js";
import { baseCommitSchema } from "../../runtime/types.js";

export type CIState = "pending" | "success" | "failure";
export interface PullRequestIdentity { id: string; number: number }
export interface PullRequestSnapshot extends PullRequestIdentity {
  repository: string;
  headBranch: string;
  baseBranch: string;
  headCommit: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  ci: CIState;
  mergedBy: { type: string; login: string } | null;
  mergedAt: string | null;
}
export interface SupervisionGitHub {
  discover(branch: string): Promise<PullRequestIdentity[]>;
  inspect(pr: PullRequestIdentity): Promise<PullRequestSnapshot>;
}

const commit = z.object({ oid: baseCommitSchema });
const pageInfo = z.object({ hasNextPage: z.boolean() });
const checkSchema = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.literal("CheckRun"), name: z.string(), status: z.string(),
    conclusion: z.string().nullable(), isRequired: z.boolean(),
    checkSuite: z.object({ commit, app: z.object({ slug: z.string(), databaseId: z.number().int().nullable() }).nullable() }) }),
  z.object({ __typename: z.literal("StatusContext"), context: z.string(), state: z.string(),
    isRequired: z.boolean(), commit }),
]);
const snapshotSchema = z.object({
  id: z.string().min(1), number: z.number().int().positive(),
  repository: z.object({ nameWithOwner: z.string() }),
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
  headRefName: z.string(), baseRefName: z.string(), headRefOid: baseCommitSchema,
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  mergedBy: z.object({ __typename: z.string(), login: z.string().min(1) }).nullable(),
  mergedAt: z.iso.datetime().nullable(),
  baseRef: z.object({
    branchProtectionRule: z.object({ requiredStatusCheckContexts: z.array(z.string()).nullable(),
      requiredStatusChecks: z.array(z.object({ context: z.string(),
        app: z.object({ databaseId: z.number().int() }).nullable() })).nullable(),
    }).nullable(),
    rules: z.object({ pageInfo, nodes: z.array(z.object({
      type: z.string(),
      repositoryRuleset: z.object({ enforcement: z.enum(["ACTIVE", "DISABLED", "EVALUATE"]) }),
      parameters: z.object({ requiredStatusChecks: z.array(z.object({ context: z.string(),
        integrationId: z.number().int().nullable() })).optional() }).nullable(),
    })) }),
  }).nullable(),
  commits: z.object({ nodes: z.array(z.object({ commit: commit.extend({
    statusCheckRollup: z.object({ contexts: z.object({ pageInfo, nodes: z.array(checkSchema) }) }).nullable(),
  }) })) }),
});

// These jobs are the repository's V1 baseline even without branch protection.
export const requiredWorkflowChecks = ["Validate sample application", "Validate orchestrator"];

export function classifyCI(raw: unknown, baseline = requiredWorkflowChecks): CIState {
  const pr = snapshotSchema.parse(raw);
  if (!pr.baseRef || pr.baseRef.rules.pageInfo.hasNextPage) throw new Error("Incomplete GitHub check policy");
  const head = pr.commits.nodes.length === 1 ? pr.commits.nodes[0]?.commit : undefined;
  if (!head || head.oid !== pr.headRefOid || !head.statusCheckRollup) return "pending";
  const contexts = head.statusCheckRollup.contexts;
  if (contexts.pageInfo.hasNextPage) throw new Error("Incomplete GitHub check evidence");
  const policy = [
    ...(pr.baseRef.branchProtectionRule?.requiredStatusCheckContexts ?? []).map((context) => ({ context, appId: null })),
    ...(pr.baseRef.branchProtectionRule?.requiredStatusChecks ?? []).map((check) => ({ context: check.context, appId: check.app?.databaseId ?? null })),
    ...pr.baseRef.rules.nodes.filter((rule) => rule.repositoryRuleset.enforcement === "ACTIVE" && rule.type === "REQUIRED_STATUS_CHECKS")
      .flatMap((rule) => {
        if (!rule.parameters?.requiredStatusChecks) throw new Error("Missing required-check policy");
        return rule.parameters.requiredStatusChecks.map((check) => ({ context: check.context, appId: check.integrationId }));
      }),
  ];
  const name = (check: z.infer<typeof checkSchema>) => check.__typename === "CheckRun" ? check.name : check.context;
  let pending = contexts.nodes.length === 0;
  // Preserve each app binding: two rules may require the same name from
  // different apps, and one passing app must not mask the other missing app.
  for (const required of policy) {
    if (!contexts.nodes.some((check) => name(check) === required.context && check.isRequired &&
      (!required.appId || required.appId < 0 || (check.__typename === "CheckRun" &&
        check.checkSuite.app?.databaseId === required.appId)))) pending = true;
  }
  for (const required of baseline) {
    if (!contexts.nodes.some((check) => check.__typename === "CheckRun" &&
      check.name === required && check.checkSuite.app?.slug === "github-actions")) pending = true;
  }
  for (const check of contexts.nodes) {
    const sha = check.__typename === "CheckRun" ? check.checkSuite.commit.oid : check.commit.oid;
    if (sha !== pr.headRefOid) return "pending";
    // Conservatively gate on all reported checks, including optional checks.
    if (check.__typename === "StatusContext") {
      if (["ERROR", "FAILURE"].includes(check.state)) return "failure";
      if (check.state !== "SUCCESS") pending = true;
    } else {
      if (check.status !== "COMPLETED") pending = true;
      else if (["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(check.conclusion ?? "")) return "failure";
      else if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? "")) pending = true;
    }
  }
  return pending ? "pending" : "success";
}

type GraphQL = (query: string, variables: Record<string, string>) => Promise<unknown>;
const execute = promisify(execFile);
const graphql: GraphQL = async (query, variables) => {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push("-f", `${key}=${value}`);
  try {
    const { stdout } = await execute("gh", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, shell: false });
    const response = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() }).parse(JSON.parse(stdout));
    if (response.errors?.length) throw new Error("GraphQL errors");
    return response.data;
  } catch { throw new Error("Unable to read authoritative GitHub supervision evidence"); }
};

export const discoveryQuery = `query($owner:String!,$repo:String!,$branch:String!) {
  repository(owner:$owner,name:$repo) {
    pullRequests(first:2,headRefName:$branch,states:[OPEN,CLOSED,MERGED]) {
      pageInfo { hasNextPage } nodes { id number headRefName baseRefName
        repository { nameWithOwner } headRepository { nameWithOwner } }
    }
  }
}`;
export const inspectionQuery = `query($id:ID!) {
  node(id:$id) { ... on PullRequest {
    id number headRefName baseRefName headRefOid state mergedAt mergedBy { __typename login }
    repository { nameWithOwner } headRepository { nameWithOwner }
    baseRef { branchProtectionRule { requiredStatusCheckContexts requiredStatusChecks { context app { databaseId } } }
      rules(first:100) { pageInfo { hasNextPage } nodes { type
        repositoryRuleset { enforcement }
        parameters { ... on RequiredStatusChecksParameters { requiredStatusChecks { context integrationId } } }
      } }
    }
    commits(last:1) { nodes { commit { oid statusCheckRollup { contexts(first:100) {
      pageInfo { hasNextPage } nodes { __typename
        ... on CheckRun { name status conclusion isRequired(pullRequestId:$id)
          checkSuite { commit { oid } app { slug databaseId } } }
        ... on StatusContext { context state isRequired(pullRequestId:$id) commit { oid } }
      }
    } } } } }
  } }
}`;

export class GitHubSupervisionAdapter implements SupervisionGitHub {
  private readonly owner: string;
  private readonly name: string;
  constructor(private readonly repository: string, private readonly read: GraphQL = graphql) {
    githubRepository({ GITHUB_REPOSITORY: repository });
    [this.owner, this.name] = repository.split("/") as [string, string];
  }

  async discover(branch: string): Promise<PullRequestIdentity[]> {
    const result = z.object({ repository: z.object({ pullRequests: z.object({ pageInfo,
      nodes: z.array(snapshotSchema.pick({ id: true, number: true, headRefName: true,
        baseRefName: true, repository: true, headRepository: true })),
    }) }) }).parse(await this.read(discoveryQuery, { owner: this.owner, repo: this.name, branch }));
    const matches = result.repository.pullRequests;
    if (matches.pageInfo.hasNextPage || matches.nodes.length > 1) throw new Error("Ambiguous PRs for assignment branch");
    for (const pr of matches.nodes) {
      if (pr.headRefName !== branch || pr.baseRefName !== "main" ||
        pr.repository.nameWithOwner !== this.repository || pr.headRepository?.nameWithOwner !== this.repository) {
        throw new Error("PR does not match the assignment repository, branch and main base");
      }
    }
    return matches.nodes.map(({ id, number }) => ({ id, number }));
  }

  async inspect(identity: PullRequestIdentity): Promise<PullRequestSnapshot> {
    const { node: pr } = z.object({ node: snapshotSchema }).parse(await this.read(inspectionQuery, { id: identity.id }));
    if (pr.id !== identity.id || pr.number !== identity.number || pr.repository.nameWithOwner !== this.repository ||
      (pr.state === "OPEN" && pr.headRepository?.nameWithOwner !== this.repository)) throw new Error("PR identity changed");
    return { id: pr.id, number: pr.number, repository: pr.repository.nameWithOwner,
      headBranch: pr.headRefName, baseBranch: pr.baseRefName, headCommit: pr.headRefOid, state: pr.state,
      ci: pr.state === "OPEN" ? classifyCI(pr) : "pending",
      mergedAt: pr.mergedAt,
      mergedBy: pr.mergedBy && { type: pr.mergedBy.__typename, login: pr.mergedBy.login } };
  }
}
