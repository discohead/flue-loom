---
name: flue-routing
description: Use when exposing Flue 2 agents over HTTP — app.ts as the explicit Hono route map, createAgentRouter mounts, the conversation URL and its routes, authentication and per-conversation authorization middleware, CORS, dispatch-only agents, webhook routes that dispatch(), channel mounts, and mounting a directory of agents.
user-invocable: false
---

# Routing: `app.ts` is the route map

Nothing is mounted automatically. The `'use agent'` scan *registers* agents (so `dispatch()`/`init()` work); `app.ts` decides which are reachable over HTTP. `app.ts` is required for `vite dev`/`vite build` and serves both Node and Cloudflare.

```ts
// src/app.ts
import { dispatch } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Support } from './agents/support.ts';
import { InvoiceAuditor } from './agents/invoice-auditor.ts';
import { canAccessTicket, verifySession } from './shared/auth.ts';
import { verifyBillingWebhook } from './shared/billing.ts';
import { channel as slack } from './channels/slack.ts';

const app = new Hono();

// Auth BEFORE the mount it protects; `/*` covers every agent route.
app.use('/agents/support/*', async (c, next) => {
	const user = await verifySession(c.req.raw);
	if (!user) return c.json({ error: 'unauthorized' }, 401);
	const [conversationId] = c.req.path.slice('/agents/support/'.length).split('/');
	if (!(await canAccessTicket(user, conversationId))) return c.json({ error: 'forbidden' }, 403);
	return next();
});
app.route('/agents/support', createAgentRouter(Support));

// Dispatch-only agent: no mount; a verified webhook feeds it.
app.post('/webhooks/billing', async (c) => {
	const event = await verifyBillingWebhook(c.req.raw);
	const receipt = await dispatch(InvoiceAuditor, {
		id: event.invoiceId,
		message: { kind: 'signal', type: 'billing.invoice.flagged', body: event.summary, attributes: { eventId: event.id } },
	});
	return c.json(receipt, 202);
});

app.route('/channels/slack', slack.route()); // verified provider ingress (flue-channels)
app.get('/health', (c) => c.text('ok'));

export default app;
```

## `createAgentRouter(Agent)`

Pure factory, no options, mount anywhere, any number of times. The mount path is **not** the identity — conversations are keyed by the agent's identity, so moving a mount needs no migration and two mounts of one agent serve the same conversations. Routes relative to the mount (`:id` = conversation id, created on first message):

| Route | Purpose |
|---|---|
| `POST /:id` | deliver one `DeliveredMessage` (+ optional top-level `initialData`, `uid`) → **202** `{ streamUrl, offset, submissionId, uid }` |
| `GET /:id` (`?view=history`) | materialized snapshot `{ v, conversationId, offset, messages, settlements }` |
| `GET /:id?view=updates&offset=…[&live=long-poll\|sse]` | incremental chunks after an offset |
| `HEAD /:id` | stream metadata headers |
| `POST /:id/abort` | abort in-flight and queued work → `{ aborted }` |
| `GET /:id/attachments/:attachmentId` | attachment bytes |

There is no synchronous "wait for reply" mode (`?wait` is rejected). Clients read the outcome from the conversation — see `flue-client`.

## Protect every mount

A mounted agent has **no built-in auth**: anyone who can reach a conversation URL can send to it, read its full history, and abort it. Production needs both authentication (who) and authorization (may this caller use *this* conversation id?). Prefer server-issued ids (`user-${user.id}`) so the check is an equality test. Keep internal agents dispatch-only, or on Cloudflare behind a private Worker reached by service binding. Channel routes are self-authenticating (signature verification) and need no extra middleware.

## CORS

The router sets no CORS headers. `vite dev`/`vite preview` apply permissive localhost CORS, so cross-origin setups that work locally can fail in production — add Hono's `cors()` middleware and expose `Stream-Next-Offset`, `Stream-Up-To-Date`, `Location` so the SDK can resume streams. Same-origin apps need nothing.

## Mount a directory of agents

```ts
import type { Agent } from '@flue/runtime';
const modules = import.meta.glob<Record<string, Agent>>('./agents/*.ts', { eager: true });
for (const mod of Object.values(modules)) {
	for (const [name, agent] of Object.entries(mod)) {
		if (typeof agent === 'function' && /^[A-Z]/.test(name)) app.route(`/agents/${agent.agentName ?? name}`, createAgentRouter(agent));
	}
}
```

## Also in `app.ts`

Module-scope setup that must run once per server: `setProvider(...)`, `observe(...)`/`instrument(...)`, in-process cron (`new Cron(...)`, Node). `app.ts` may be any object with `fetch(request, env, ctx)` (`Fetchable`); Hono is the convention. On Cloudflare, non-HTTP handlers (`scheduled`, `queue`, email) go in `cloudflare.ts`, never a `fetch` there.

Docs: `flue docs read guide/routing`, `reference/streaming-protocol`, `reference/agent-api` (createAgentRouter, Fetchable).
