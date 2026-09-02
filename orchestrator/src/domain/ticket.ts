export type TicketStatus =
  | "backlog"
  | "in_progress"
  | "in_review"
  | "done"
  | "failed";

export interface Ticket {
  id: string;
  title: string;
  status: TicketStatus;
  blockedBy: string[];
}
