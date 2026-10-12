---
name: flue-channels
description: Use when connecting Flue 2 agents to Slack, GitHub, Discord, Microsoft Teams, Google Chat, Telegram, WhatsApp, Messenger, Twilio, Linear, Notion, Intercom, Zendesk, Stripe, Shopify, Resend, or Salesforce — flue add channel blueprints, the channel module and its app.ts mount, signals, instanceId, idempotencyKey, initialData, and narrow outbound tools over the provider's own SDK.
user-invocable: false
---

# Channels

A channel is **verified inbound HTTP** from a provider: the `@flue/<provider>` package checks signatures against the raw body, enforces replay windows, answers protocol handshakes, and calls your handler with the native payload. Your handler picks a conversation and `dispatch()`es. **Outbound** (replying, posting) is your code using the provider's own SDK — Flue has no send-message abstraction.

## Add one with a blueprint (don't hand-roll)

```bash
npx flue add channel slack --print          # a Markdown guide for you (the coding agent) to apply
npx flue add                                 # list all blueprints
npx flue add channel https://developers.example.com/webhooks --print   # unlisted provider: generic guide
```

Blueprints are versioned implementation guides, not installers: they inspect the target and layout, install `@flue/<provider>` + the provider SDK, create `src/channels/<provider>.ts` (named `channel` and `client` exports, first line `// flue-blueprint: channel/<provider>@<n>`), mount it in `app.ts`, bind reply tools into the agent, and describe env vars and verification. `npx flue update channel <provider> --print` upgrades an existing integration (compares against the marker, preserves customizations). `/flue-loom:add` runs this flow.

Catalog (2.1.1): slack, discord, teams, google-chat, telegram, whatsapp, messenger, twilio, github, linear, notion, intercom, zendesk, stripe, shopify, resend, salesforce-marketing-cloud.

## Shape of a channel module

```ts
// src/channels/slack.ts
import { dispatch, defineTool } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);

export const channel = createSlackChannel({
	signingSecret: process.env.SLACK_SIGNING_SECRET!,
	async events({ payload }) {
		// served at POST <mount>/events
		if (payload.type !== 'event_callback' || payload.event.type !== 'app_mention') return;
		const event = payload.event;
		const thread = { teamId: payload.team_id, channelId: event.channel, threadTs: event.thread_ts ?? event.ts };
		await dispatch(Assistant, {
			id: channel.instanceId(thread), // canonical, collision-free conversation id per thread
			idempotencyKey: payload.event_id, // provider retries converge on one submission
			initialData: { channelId: thread.channelId, threadTs: thread.threadTs }, // recorded once, at creation
			message: { kind: 'signal', type: 'slack.app_mention', body: event.text, attributes: { user: event.user } },
		});
	}, // return nothing → 200; return JSON or a Response when the protocol reads the ack
});

export function replyInThread(ref: { channelId: string; threadTs: string }) {
	return defineTool({
		name: 'reply_in_slack_thread',
		description: 'Reply in the Slack thread bound to this conversation.',
		input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			const res = await client.chat.postMessage({ channel: ref.channelId, thread_ts: ref.threadTs, text: data.text });
			return { output: { ts: res.ts ?? null } };
		},
	});
}
```

```ts
// src/app.ts
app.route('/channels/slack', slack.route()); // register <public origin>/channels/slack/events with Slack
```

```ts
// the agent — trusted destination from creation data, never from the model
export function Assistant() {
	useModel('anthropic/claude-sonnet-5');
	const thread = useInitialData<v.InferOutput<typeof Assistant.initialData>>();
	useTool(replyInThread(thread));
	return 'You participate in one Slack thread. Reply with reply_in_slack_thread when a response is called for.';
}
Assistant.initialData = v.object({ channelId: v.string(), threadTs: v.string() });
```

## Conventions

- **Handlers select routes** (`events` → `/events`, most providers: `webhook` → `/webhook`); the URL you register with the provider is your mount + suffix. Channel routes need no auth middleware — verification is the auth.
- **Acknowledge fast**: `dispatch()` returns at admission; never await agent output in the handler.
- **Deliveries repeat**: packages don't dedupe. Pass the provider's redelivery-stable id as `idempotencyKey` (≤ 256 chars; same receipt with `deduplicated: true`; reusing it with a different payload → 409 `submission_conflict`).
- **Signals, not user messages**, for multi-party surfaces (`type: 'github.issue_comment.created'`, string `attributes`). Keep short-lived capabilities (interaction tokens, `response_url`) out of messages — they enter model context and history.
- **Conversation ids**: conversation-shaped providers (Slack thread, GitHub issue, Teams chat) expose `channel.instanceId(ref)` (+ `parseInstanceId()` as an escape hatch); event feeds (Stripe, Shopify, Notion, Resend) have no helper — choose per customer/order/occurrence yourself.
- **Outbound** tools bind the destination/credential in trusted code (closures over `useInitialData()`); expose only the narrow actions the app needs. OAuth install flows and token storage are yours.
- The dispatch target needs no mount. Channels run on Node and Cloudflare (Fetch + Web Crypto).

## Hand-written channel

```ts
import { createChannelRouter } from '@flue/runtime';
app.route('/channels/acme', createChannelRouter([{ method: 'POST', path: '/webhook', handler: acmeWebhook }]));
```

Verify signatures against the exact unconsumed body before parsing; test valid, invalid, and handshake requests. Long-lived sockets and polling stay outside channels.

Docs: `flue docs read guide/channels`, `ecosystem/channels/<provider>`, `cli/add`.
