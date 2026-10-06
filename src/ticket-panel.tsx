import { useState } from "react";
import { Badge, Button, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  XCircleIcon,
  WarningIcon,
  TicketIcon
} from "@phosphor-icons/react";
import type { DeskState, Ticket, TicketStatus } from "./shared";

const statusLabel: Record<TicketStatus, string> = {
  triaged: "Triaged",
  policy_check: "Policy check…",
  awaiting_approval: "Needs approval",
  sent: "Reply sent",
  rejected: "Reply rejected"
};

const priorityClass: Record<Ticket["priority"], string> = {
  P1: "bg-red-500/15 text-red-500",
  P2: "bg-orange-500/15 text-orange-500",
  P3: "bg-yellow-500/15 text-yellow-600",
  P4: "bg-kumo-control text-kumo-subtle"
};

function TicketCard({
  ticket,
  active,
  onApprove,
  onReject
}: {
  ticket: Ticket;
  active: boolean;
  onApprove: (id: string) => Promise<unknown>;
  onReject: (id: string, reason: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`rounded-xl border p-3 space-y-2 bg-kumo-base ${
        active ? "border-kumo-brand" : "border-kumo-line"
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${priorityClass[ticket.priority]}`}
        >
          {ticket.priority}
        </span>
        <span className="text-xs font-mono text-kumo-subtle">{ticket.id}</span>
        <Badge variant="secondary">{ticket.category}</Badge>
        <span className="ml-auto text-xs text-kumo-subtle">
          {statusLabel[ticket.status]}
        </span>
      </div>
      <Text size="sm" bold>
        {ticket.subject}
      </Text>
      <div className="text-xs text-kumo-subtle">{ticket.customerEmail}</div>
      <p className="text-sm text-kumo-default leading-snug">{ticket.summary}</p>

      {ticket.draftReply && (
        <details open={ticket.status === "awaiting_approval"}>
          <summary className="text-xs font-medium cursor-pointer text-kumo-default">
            Draft reply
          </summary>
          <pre className="mt-1 whitespace-pre-wrap text-xs bg-kumo-control rounded-lg p-2 text-kumo-default font-sans">
            {ticket.draftReply}
          </pre>
        </details>
      )}

      {ticket.policyIssues && ticket.policyIssues.length > 0 && (
        <div className="rounded-lg bg-orange-500/10 border border-orange-500/30 p-2 space-y-1">
          <div className="flex items-center gap-1 text-xs font-medium text-orange-500">
            <WarningIcon size={12} /> Policy check flagged
          </div>
          <ul className="list-disc pl-4 text-xs text-kumo-default">
            {ticket.policyIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {ticket.status === "rejected" && ticket.rejectionReason && (
        <div className="text-xs text-kumo-danger">
          Rejected: {ticket.rejectionReason}
        </div>
      )}

      {ticket.status === "awaiting_approval" && (
        <div className="flex gap-2 pt-1">
          <Button
            variant="primary"
            size="sm"
            icon={<CheckCircleIcon size={14} />}
            disabled={busy}
            onClick={() => act(() => onApprove(ticket.id))}
          >
            Approve & send
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<XCircleIcon size={14} />}
            disabled={busy}
            onClick={() =>
              act(() =>
                onReject(
                  ticket.id,
                  window.prompt("Why are you rejecting this reply?") ||
                    "Rejected by support engineer"
                )
              )
            }
          >
            Reject
          </Button>
        </div>
      )}
      {error && <div className="text-xs text-kumo-danger">{error}</div>}
    </div>
  );
}

export function TicketPanel({
  desk,
  onApprove,
  onReject
}: {
  desk: DeskState;
  onApprove: (id: string) => Promise<unknown>;
  onReject: (id: string, reason: string) => Promise<unknown>;
}) {
  return (
    <aside className="hidden md:flex w-[380px] shrink-0 flex-col border-l border-kumo-line bg-kumo-elevated">
      <div className="px-4 py-3 border-b border-kumo-line flex items-center gap-2">
        <TicketIcon size={16} className="text-kumo-brand" />
        <Text size="sm" bold>
          Ticket queue
        </Text>
        <span className="ml-auto text-xs text-kumo-subtle">
          {desk.tickets.length} ticket{desk.tickets.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {desk.tickets.length === 0 ? (
          <p className="text-sm text-kumo-subtle px-1">
            Triaged tickets show up here. Replies the agent drafts wait here for
            your approval before they're sent.
          </p>
        ) : (
          desk.tickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              active={t.id === desk.activeTicketId}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))
        )}
      </div>
    </aside>
  );
}
