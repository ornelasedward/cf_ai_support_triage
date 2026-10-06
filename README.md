# cf_ai_support_triage

**Live demo:** https://cf-ai-support-triage.ornelasedward.workers.dev

An AI support triage agent built on Cloudflare. A support engineer pastes a customer ticket into a chat, and the agent looks up the account, checks the customer's zone, searches past tickets, triages it (category, priority, suspected root cause) and drafts a reply. Every reply then goes through a durable Workflow: an automated policy check, a pause until a human approves or rejects it, and only then the send step.

It's modeled on the internal support tooling a platform team runs, so the interesting parts are the ones that matter in production: tool calls against real account data instead of guesses, a human approval gate that survives restarts, and memory that carries over from one ticket to the next.

## How it maps to the assignment

| Requirement | How it's built |
|---|---|
| **LLM** | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on Workers AI, used for the chat agent with tool calling and for the policy check inside the workflow (JSON-schema output). |
| **Workflow / coordination** | `ChatAgent` is a Durable Object (Agents SDK `AIChatAgent`). Submitting a reply starts `ReplyWorkflow`, a Cloudflare Workflow (`AgentWorkflow`) with three steps: `policy-check` → `waitForApproval` → `send-reply`. The workflow reports back to the agent over RPC and updates its state. |
| **User input** | A React chat UI (Vite, served as Worker static assets) streaming over WebSockets, with a live ticket queue panel where the engineer approves or rejects drafted replies. |
| **Memory / state** | Agent state (the ticket queue) is persisted and synced to every connected client in real time. Long-term memory lives in the Durable Object's SQLite database: every ticket with its final sent reply, plus per-customer notes the agent saves. `lookupAccount` returns a customer's past tickets and notes, and `searchPastTickets` reuses resolutions from earlier tickets. |

## Architecture

```
Browser (React chat + ticket queue)
   │  WebSocket: chat stream, state sync, @callable RPC (approve / reject)
   ▼
ChatAgent  ── Durable Object (AIChatAgent)
   ├─ Llama 3.3 on Workers AI, tool calling:
   │    lookupAccount · checkZoneHealth · searchPastTickets
   │    saveTicket · submitReplyForApproval · rememberCustomerNote
   ├─ state: ticket queue (synced to clients)
   └─ SQLite: tickets, customer_notes (long-term memory)
         │ runWorkflow()                ▲ updateTicket() over RPC
         ▼                              │
ReplyWorkflow ── Cloudflare Workflow (AgentWorkflow)
   1. policy-check   Llama 3.3 flags refund/credit promises, other customers' data, secrets, tone
   2. waitForApproval   durable pause until approveReply / rejectReply from the UI (24h timeout)
   3. send-reply     records the reply as the ticket's resolution
```

Account and zone data come from `src/mock-data.ts`, standing in for the internal account, DNS/SSL and analytics services a real support platform would call.

## Try it

Three sample customers are built in. Click one of the starter prompts or paste something like:

- `Ticket from ops@acme.dev: our site started showing error 526 this morning, nothing changed on our side.` (invalid origin certificate under Full (strict))
- `owner@pixelbakery.co says pixelbakery.co is down with a 522 and they need it back up before a sale tonight.` (origin timing out, Flexible SSL)
- `secops@northwind.io: legit API calls from our partners to api.northwind.io are getting blocked since yesterday.` (WAF managed rule false positive, and the edge cert expires in 12 days)

Then ask it to "draft a reply". Watch the ticket in the right-hand panel move from **Policy check** to **Needs approval**. Approve or reject it there. Once a reply is sent, open a new ticket with a similar problem and the agent will find the earlier resolution with `searchPastTickets`.

## Running locally

Requirements: Node 20+, a Cloudflare account (Workers AI runs remotely even in local dev).

```bash
npm install
npx wrangler login
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

## Deploying

```bash
npm run deploy
```

This builds the client and deploys the Worker, the `ChatAgent` Durable Object (SQLite-backed) and the `reply-workflow` Workflow.

## Project layout

- `src/server.ts`: `ChatAgent` (chat, tools, state, SQLite memory, approve/reject RPC) and `ReplyWorkflow`
- `src/shared.ts`: ticket and desk-state types shared by the server and UI
- `src/mock-data.ts`: sample accounts and zone health data
- `src/app.tsx`: chat UI (adapted from the Cloudflare agents starter)
- `src/ticket-panel.tsx`: live ticket queue with the approval controls
- `wrangler.jsonc`: Workers AI, Durable Object and Workflow bindings
- `PROMPTS.md`: AI prompts used to build the project, plus the prompts the app itself runs

Built from [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter).
