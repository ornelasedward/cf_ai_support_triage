// Types shared by the agent (server.ts) and the UI (app.tsx).

export type TicketStatus =
  | "triaged"
  | "policy_check"
  | "awaiting_approval"
  | "sent"
  | "rejected";

export type Priority = "P1" | "P2" | "P3" | "P4";

export type Category =
  | "ssl"
  | "dns"
  | "origin_errors"
  | "waf"
  | "billing"
  | "account"
  | "other";

export type Ticket = {
  id: string;
  customerEmail: string;
  subject: string;
  category: Category;
  priority: Priority;
  summary: string;
  status: TicketStatus;
  draftReply?: string;
  policyIssues?: string[];
  workflowId?: string;
  rejectionReason?: string;
  updatedAt: string;
};

export type DeskState = {
  activeTicketId: string | null;
  tickets: Ticket[];
};

export const initialDeskState: DeskState = {
  activeTicketId: null,
  tickets: []
};
