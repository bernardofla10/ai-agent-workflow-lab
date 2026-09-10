import { LinearClient } from "@linear/sdk";
import type { Ticket, TicketStatus } from "../../domain/ticket.js";

export interface TicketProvider {
  getTickets(): Promise<Ticket[]>;
}

interface State {
  name: string;
  type: string;
}

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

interface PageArguments {
  first: number;
  after?: string;
  includeArchived: boolean;
}

export interface LinearIssue {
  identifier: string;
  title: string;
  archivedAt?: Date | null;
  state: PromiseLike<State | undefined> | undefined;
  inverseRelations(args: PageArguments): PromiseLike<Page<{
    type: string;
    issue: PromiseLike<{ identifier: string } | undefined> | undefined;
  }>>;
}

export interface LinearSource {
  project(id: string): PromiseLike<{
    issues(args: PageArguments): PromiseLike<Page<LinearIssue>>;
  }>;
}

export function mapLinearStatus(state: State): TicketStatus {
  switch (state.type) {
    case "triage":
    case "backlog":
    case "unstarted": return "backlog";
    case "started":
      return /\breview\b/i.test(state.name) ? "in_review" : "in_progress";
    case "completed": return "done";
    case "canceled":
    case "duplicate": return "failed";
    default: throw new Error(`Unsupported Linear workflow state type: ${state.type}`);
  }
}

// Do not expose SDK request details (which may contain authentication headers).
async function read<T>(operation: () => PromiseLike<T> | T): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error("Unable to read Linear data; check credentials, project access and connectivity");
  }
}

async function allPages<T>(fetch: (after?: string) => PromiseLike<Page<T>>): Promise<T[]> {
  const nodes: T[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  while (true) {
    const page = await read(() => fetch(after));
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    const cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) throw new Error("Invalid Linear pagination cursor");
    cursors.add(cursor);
    after = cursor;
  }
}

export async function normalizeLinearIssue(issue: LinearIssue): Promise<Ticket> {
  const state = await read(() => issue.state);
  if (!state) throw new Error(`Missing Linear workflow state for ${issue.identifier}`);
  const status = mapLinearStatus(state);
  // A blocks relation is source -> target. inverseRelations provides incoming edges.
  const relations = await allPages((after) => issue.inverseRelations({
    first: 100, after, includeArchived: false,
  }));
  const blockedBy: string[] = [];
  for (const relation of relations) {
    if (relation.type !== "blocks") continue;
    const source = await read(() => relation.issue);
    if (!source) throw new Error(`Missing blocking issue for ${issue.identifier}`);
    blockedBy.push(source.identifier);
  }
  return {
    id: issue.identifier,
    title: issue.title,
    // Preserve completed archived prerequisites without scheduling archived work.
    status: issue.archivedAt && status !== "done" ? "failed" : status,
    blockedBy: [...new Set(blockedBy)].sort((a, b) => a.localeCompare(b)),
  };
}

export class LinearTicketProvider implements TicketProvider {
  constructor(private readonly client: LinearSource, private readonly projectId: string) {}

  static fromApiKey(apiKey: string, projectId: string): LinearTicketProvider {
    return new LinearTicketProvider(new LinearClient({ apiKey }), projectId);
  }

  async getTickets(): Promise<Ticket[]> {
    const project = await read(() => this.client.project(this.projectId));
    const issues = await allPages((after) => project.issues({
      first: 100, after, includeArchived: true,
    }));
    const tickets: Ticket[] = [];
    for (const issue of issues) tickets.push(await normalizeLinearIssue(issue));
    return tickets.sort((a, b) => a.id.localeCompare(b.id));
  }
}
