import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  simulateStreamingMiddleware,
  stepCountIs,
  streamText,
  tool,
  wrapLanguageModel
} from "ai";
import { z } from "zod";
import {
  findAccount,
  findAccountByZone,
  getZoneHealth,
  sampleCustomers
} from "./mock-data";
import {
  initialDeskState,
  type DeskState,
  type Ticket,
  type TicketStatus
} from "./shared";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You are a Tier 1 support triage agent on Cloudflare's internal support platform. A support engineer pastes customer tickets into this chat and works them with you.

For every new ticket:
1. Identify the customer email or zone in the ticket, then call lookupAccount (and checkZoneHealth for any zone involved). Never guess account data.
2. Call searchPastTickets with a few keywords to reuse what worked before.
3. Call saveTicket with a category, a priority (P1 = outage or security incident on a paid plan, P2 = partial outage, P3 = degraded or config question, P4 = how-to) and a one or two sentence summary of the root cause you suspect.
4. Explain your triage to the engineer in a few short bullet points.
5. When the engineer asks for a reply (or the fix is clear), write a plain, friendly customer reply and call submitReplyForApproval. Replies go through a policy check and a human approval step before they are sent, so do not claim it was sent.

Be specific. Base the summary and the reply on the exact signals the tools return, not general guesses. Common patterns: a 526 with originCertValid false under full_strict means the origin certificate is invalid or expired (fix: install a valid or Cloudflare Origin CA certificate, or temporarily use Full); a 522 means Cloudflare could not reach the origin in time (check the origin is up and allows Cloudflare IPs; Flexible SSL can also cause redirect loops); high WAF blocks with one managed rule on legitimate traffic points to a false positive (fix: a scoped skip or exception for that rule, not turning the WAF off). Mention anything else the data shows that the customer should know, like a certificate expiring soon. A good reply names the cause, gives the concrete next step, and offers to help.

Rules: never promise refunds, credits or SLA payouts. Never include data from another customer's account. If you learn something about a customer that will matter next time (preferences, recurring issues), call rememberCustomerNote. Keep answers short. Sample customers you can test with: ${sampleCustomers.join(", ")}.`;

type TicketRow = {
  id: string;
  customer_email: string;
  subject: string;
  category: string;
  priority: string;
  summary: string;
  status: string;
  final_reply: string | null;
  updated_at: string;
};

export class ChatAgent extends AIChatAgent<Env, DeskState> {
  initialState: DeskState = initialDeskState;
  maxPersistedMessages = 200;
  chatRecovery = true;

  onStart() {
    // Long-term memory lives in the Durable Object's SQLite database, so it
    // survives across chats, sessions and deploys.
    this.sql`CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      customer_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      category TEXT NOT NULL,
      priority TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      final_reply TEXT,
      updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS customer_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_email TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
  }

  // ---- State helpers -------------------------------------------------------

  private upsertTicket(ticket: Ticket) {
    const others = this.state.tickets.filter((t) => t.id !== ticket.id);
    this.setState({
      activeTicketId: ticket.id,
      tickets: [ticket, ...others].slice(0, 25)
    });
    this
      .sql`INSERT INTO tickets (id, customer_email, subject, category, priority, summary, status, final_reply, updated_at)
      VALUES (${ticket.id}, ${ticket.customerEmail}, ${ticket.subject}, ${ticket.category}, ${ticket.priority}, ${ticket.summary}, ${ticket.status}, NULL, ${ticket.updatedAt})
      ON CONFLICT(id) DO UPDATE SET
        subject = excluded.subject, category = excluded.category, priority = excluded.priority,
        summary = excluded.summary, status = excluded.status, updated_at = excluded.updated_at`;
  }

  private getTicket(id: string): Ticket | undefined {
    return this.state.tickets.find((t) => t.id === id);
  }

  /** Called by ReplyWorkflow over RPC to move a ticket through its lifecycle. */
  async updateTicket(id: string, patch: Partial<Ticket>, finalReply?: string) {
    const current = this.getTicket(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.setState({
      ...this.state,
      tickets: this.state.tickets.map((t) => (t.id === id ? next : t))
    });
    this
      .sql`UPDATE tickets SET status = ${next.status}, updated_at = ${next.updatedAt},
      final_reply = COALESCE(${finalReply ?? null}, final_reply) WHERE id = ${id}`;
  }

  // ---- Human-in-the-loop controls (called from the UI) ---------------------

  @callable()
  async approveReply(ticketId: string) {
    const ticket = this.getTicket(ticketId);
    if (!ticket?.workflowId || ticket.status !== "awaiting_approval") {
      throw new Error("This ticket has no reply waiting for approval.");
    }
    await this.approveWorkflow(ticket.workflowId, {
      reason: "Approved by support engineer"
    });
  }

  @callable()
  async rejectReply(ticketId: string, reason: string) {
    const ticket = this.getTicket(ticketId);
    if (!ticket?.workflowId || ticket.status !== "awaiting_approval") {
      throw new Error("This ticket has no reply waiting for approval.");
    }
    await this.rejectWorkflow(ticket.workflowId, { reason });
  }

  @callable()
  async resetDesk() {
    this.sql`DELETE FROM tickets`;
    this.sql`DELETE FROM customer_notes`;
    this.setState(initialDeskState);
  }

  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ) {
    // A rejection (or approval timeout) also surfaces here, but the workflow
    // records those itself, so only failures before approval are handled.
    const ticket = this.state.tickets.find((t) => t.workflowId === workflowId);
    if (ticket && ticket.status === "policy_check") {
      await this.updateTicket(ticket.id, {
        status: "triaged",
        policyIssues: [`Workflow failed: ${error}`]
      });
    }
  }

  // ---- Chat ----------------------------------------------------------------

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      // Llama 3.3's streamed tool-call deltas come back garbled through the
      // provider, so generate each step whole and replay it as a stream.
      model: wrapLanguageModel({
        model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
        middleware: simulateStreamingMiddleware()
      }),
      system: SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        lookupAccount: tool({
          description:
            "Look up a customer account by email or by one of its zones (domains). Returns plan, zones, past tickets and saved notes about the customer.",
          inputSchema: z.object({
            emailOrZone: z
              .string()
              .describe("Customer email address or zone, e.g. acme.dev")
          }),
          execute: async ({ emailOrZone }) => {
            const account = emailOrZone.includes("@")
              ? findAccount(emailOrZone)
              : findAccountByZone(emailOrZone);
            if (!account) return { found: false, emailOrZone };
            const pastTickets = this.sql<TicketRow>`
              SELECT id, subject, category, priority, status, summary, updated_at FROM tickets
              WHERE customer_email = ${account.email} ORDER BY updated_at DESC LIMIT 5`;
            const notes = this.sql<{ note: string; created_at: string }>`
              SELECT note, created_at FROM customer_notes
              WHERE customer_email = ${account.email} ORDER BY id DESC LIMIT 10`;
            return { found: true, account, pastTickets, notes };
          }
        }),

        checkZoneHealth: tool({
          description:
            "Check a zone's SSL mode, certificate status, DNS proxy status, 5xx error rate and WAF activity over the last hour.",
          inputSchema: z.object({
            zone: z.string().describe("Zone (domain), e.g. acme.dev")
          }),
          execute: async ({ zone }) =>
            getZoneHealth(zone) ?? { found: false, zone }
        }),

        searchPastTickets: tool({
          description:
            "Search every past ticket (all customers) by keyword to find similar issues and how they were resolved. Only use the resolution pattern, never another customer's details.",
          inputSchema: z.object({
            keywords: z
              .string()
              .describe("One or two keywords, e.g. '526' or 'flexible ssl'")
          }),
          execute: async ({ keywords }) => {
            const like = `%${keywords.toLowerCase()}%`;
            const rows = this.sql<TicketRow>`
              SELECT category, priority, summary, final_reply FROM tickets
              WHERE status = 'sent' AND (lower(subject) LIKE ${like} OR lower(summary) LIKE ${like} OR lower(category) LIKE ${like})
              ORDER BY updated_at DESC LIMIT 3`;
            return rows.length > 0 ? rows : "No similar resolved tickets yet.";
          }
        }),

        saveTicket: tool({
          description:
            "Create or update the triaged ticket. Call this once you know the customer, category, priority and suspected root cause.",
          inputSchema: z.object({
            ticketId: z
              .string()
              .optional()
              .describe("Existing ticket id to update; omit for a new ticket"),
            customerEmail: z.string(),
            subject: z.string().describe("Short ticket subject"),
            category: z.enum([
              "ssl",
              "dns",
              "origin_errors",
              "waf",
              "billing",
              "account",
              "other"
            ]),
            priority: z.enum(["P1", "P2", "P3", "P4"]),
            summary: z
              .string()
              .describe("One or two sentences on the suspected root cause")
          }),
          execute: async (input) => {
            const existing = input.ticketId
              ? this.getTicket(input.ticketId)
              : undefined;
            const ticket: Ticket = {
              ...(existing ?? { status: "triaged" as TicketStatus }),
              id:
                existing?.id ??
                `TCK-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
              customerEmail: input.customerEmail,
              subject: input.subject,
              category: input.category,
              priority: input.priority,
              summary: input.summary,
              updatedAt: new Date().toISOString()
            };
            this.upsertTicket(ticket);
            return { saved: true, ticketId: ticket.id, status: ticket.status };
          }
        }),

        submitReplyForApproval: tool({
          description:
            "Submit a drafted customer reply. It runs an automated policy check, then waits for a human to approve it in the ticket panel before it is sent.",
          inputSchema: z.object({
            ticketId: z.string(),
            reply: z.string().describe("The full reply to the customer")
          }),
          execute: async ({ ticketId, reply }) => {
            const ticket = this.getTicket(ticketId);
            if (!ticket) return { error: `Unknown ticket ${ticketId}` };
            if (
              ticket.status === "awaiting_approval" ||
              ticket.status === "policy_check"
            ) {
              return { error: "A reply for this ticket is already pending." };
            }
            const workflowId = await this.runWorkflow(
              "REPLY_WORKFLOW",
              { ticketId, reply, customerEmail: ticket.customerEmail },
              { metadata: { ticketId } }
            );
            await this.updateTicket(ticketId, {
              status: "policy_check",
              draftReply: reply,
              workflowId,
              policyIssues: [],
              rejectionReason: undefined
            });
            return {
              submitted: true,
              ticketId,
              next: "Policy check running, then waiting for human approval in the ticket panel."
            };
          }
        }),

        rememberCustomerNote: tool({
          description:
            "Save a durable note about a customer for future tickets (preferences, recurring issues, context).",
          inputSchema: z.object({
            customerEmail: z.string(),
            note: z.string()
          }),
          execute: async ({ customerEmail, note }) => {
            this
              .sql`INSERT INTO customer_notes (customer_email, note, created_at)
              VALUES (${customerEmail}, ${note}, ${new Date().toISOString()})`;
            return { saved: true };
          }
        })
      },
      stopWhen: stepCountIs(10),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

// ---- Workflow: policy check -> human approval -> send ----------------------

type ReplyParams = { ticketId: string; reply: string; customerEmail: string };

export class ReplyWorkflow extends AgentWorkflow<ChatAgent, ReplyParams> {
  async run(event: AgentWorkflowEvent<ReplyParams>, step: AgentWorkflowStep) {
    const { ticketId, reply } = event.payload;

    // Step 1: automated policy check with Llama 3.3 (retried on failure).
    const policy = await step.do("policy-check", async () => {
      const res = (await this.env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content:
              'You review customer support replies before they are sent. Flag only real problems: promises of refunds, credits or SLA payouts; mentions of other customers or their data; secrets, API tokens or passwords; rude or blaming tone. Respond with JSON only: {"ok": boolean, "issues": string[]}'
          },
          { role: "user", content: reply }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              issues: { type: "array", items: { type: "string" } }
            },
            required: ["ok", "issues"]
          }
        }
      })) as { response?: unknown };
      const raw = res.response;
      const parsed =
        typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
      const { ok, issues } = parsed as { ok?: boolean; issues?: string[] };
      return { ok: ok !== false, issues: Array.isArray(issues) ? issues : [] };
    });

    await step.do("mark-awaiting-approval", async () => {
      await this.agent.updateTicket(ticketId, {
        status: "awaiting_approval",
        policyIssues: policy.issues
      });
    });

    // Step 2: pause durably until a human approves or rejects in the UI.
    try {
      await this.waitForApproval(step, { timeout: "24 hours" });
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).replace(
        /^Workflow rejected:\s*/,
        ""
      );
      await step.do("mark-rejected", async () => {
        await this.agent.updateTicket(ticketId, {
          status: "rejected",
          rejectionReason: reason
        });
      });
      return { sent: false };
    }

    // Step 3: "send" the reply. A real platform would call the ticketing
    // system's API here; we record the final reply as the resolution.
    await step.do("send-reply", async () => {
      await this.agent.updateTicket(ticketId, { status: "sent" }, reply);
    });
    await step.reportComplete({ sent: true });
    return { sent: true };
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
