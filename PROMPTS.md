# Prompts

I built this with an AI coding assistant, which the assignment encourages. I chose what to build and who it was for, set the direction, and reviewed the result. The assistant wrote most of the code. Below are my prompts, in order, followed by the prompts the app itself sends to Llama 3.3.

## How I approached it

I applied to the Systems Engineer role on Product Platform Tools, the team that builds Cloudflare's internal support and admin platform. So instead of a generic chatbot, I wanted something that team would actually recognize: a support engineer pastes a ticket, the agent looks up real account data instead of guessing, drafts a reply, and nothing reaches the customer until a human approves it. Getting that human gate right is the same thing I deal with at BB TraderX, where anything that touches people's money goes through a check first.

## My prompts

1. > https://agents.cloudflare.com/ lets build this

2. I pasted the assignment text:
   > We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components: LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice; Workflow / coordination (recommend using Workflows, Workers or Durable Objects); User input via chat or voice (recommend using Pages or Realtime); Memory or state … AI-assisted coding is encouraged, but you have to submit prompt history.

3. The assistant proposed three directions (a support triage agent, a trading strategy builder like the AI Studio feature I built at BB TraderX, and a job application copilot). I picked:
   > Support triage agent: chat with an agent that triages a support ticket, looks up mock account/zone data via tools, drafts a reply, and kicks off a Workflow that waits for human approval before 'sending'. Remembers each ticket's history.

4. I logged in to Cloudflare (`wrangler login`) so Workers AI could run in local dev, and had the assistant run the app end to end in a browser and fix whatever broke.

## What came out of testing

- **Garbled tool calls.** The first ticket failed: every `lookupAccount` call received mangled arguments like `opsops@@acacmeme.dev`. Llama 3.3's streamed tool-call deltas were being merged twice by the provider. The fix was to wrap the model with the AI SDK's `simulateStreamingMiddleware`, so each step is generated whole and replayed as a stream.
- **Vague replies.** Once the tools worked, triage was correct but the summary and reply stayed generic, even though the zone data clearly showed `originCertValid: false`. A useful reply has to name the cause and the fix, so the system prompt got a "be specific" section mapping 526, 522 and WAF signals to concrete causes and next steps. After that, the 526 reply named the invalid origin certificate and the Origin CA fix, and the WAF reply named the exact managed rule and suggested a scoped skip instead of turning the WAF off.
- **Reject flow.** Rejecting a reply also triggered the workflow's error handler, which showed a misleading "Workflow failed" warning. Rejections are now handled only as rejections.
- **Reset** only cleared the ticket queue, not the chat, so it now clears both.

## Prompts the app runs

### Chat agent system prompt (`src/server.ts`)

```
You are a Tier 1 support triage agent on Cloudflare's internal support platform. A support engineer pastes customer tickets into this chat and works them with you.

For every new ticket:
1. Identify the customer email or zone in the ticket, then call lookupAccount (and checkZoneHealth for any zone involved). Never guess account data.
2. Call searchPastTickets with a few keywords to reuse what worked before.
3. Call saveTicket with a category, a priority (P1 = outage or security incident on a paid plan, P2 = partial outage, P3 = degraded or config question, P4 = how-to) and a one or two sentence summary of the root cause you suspect.
4. Explain your triage to the engineer in a few short bullet points.
5. When the engineer asks for a reply (or the fix is clear), write a plain, friendly customer reply and call submitReplyForApproval. Replies go through a policy check and a human approval step before they are sent, so do not claim it was sent.

Be specific. Base the summary and the reply on the exact signals the tools return, not general guesses. Common patterns: a 526 with originCertValid false under full_strict means the origin certificate is invalid or expired (fix: install a valid or Cloudflare Origin CA certificate, or temporarily use Full); a 522 means Cloudflare could not reach the origin in time (check the origin is up and allows Cloudflare IPs; Flexible SSL can also cause redirect loops); high WAF blocks with one managed rule on legitimate traffic points to a false positive (fix: a scoped skip or exception for that rule, not turning the WAF off). Mention anything else the data shows that the customer should know, like a certificate expiring soon. A good reply names the cause, gives the concrete next step, and offers to help.

Rules: never promise refunds, credits or SLA payouts. Never include data from another customer's account. If you learn something about a customer that will matter next time (preferences, recurring issues), call rememberCustomerNote. Keep answers short.
```

### Policy check (`ReplyWorkflow`, step `policy-check`)

```
You review customer support replies before they are sent. Flag only real problems: promises of refunds, credits or SLA payouts; mentions of other customers or their data; secrets, API tokens or passwords; rude or blaming tone. Respond with JSON only: {"ok": boolean, "issues": string[]}
```

Sent with a JSON schema `response_format`, so the workflow gets structured output back.
