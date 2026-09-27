#!/usr/bin/env node
// Talk to one Flue 2 agent conversation over HTTP, from the terminal.
//
// Speaks the documented conversation protocol directly — POST admission
// (202), GET ?view=updates long-poll, GET ?view=history — so it runs from the
// plugin directory with no dependencies (Node >= 22). Same semantics as
// @flue/sdk's send()/read()/history()/abort(). Streams progress (text deltas,
// tool calls, data parts) to stderr and prints only the reply to stdout, so
// it composes with pipes; --json prints one machine-readable envelope.
//
// Exit codes: 0 completed · 1 failed · 130 aborted · 124 wait timed out
//             (the submission keeps running) · 2 usage/HTTP error.

import { parseArgs } from 'node:util';

const USAGE = `usage: flue-talk.mjs <conversation-url> [options] [message...]

A conversation URL is the agent's app.ts mount plus a conversation id, e.g.
http://localhost:5173/agents/support/ticket-42 (created on first message).

  -m, --message <text>   user message (or pass it as trailing words)
  --signal <type>        deliver as kind:"signal" with this type instead
  --attr <k=v>           signal attribute (repeatable)
  --tag-name <name>      signal XML tag override
  --data <json>          initialData, recorded only when this send creates the conversation
  --new                  create only (uid: null) — 409 if it already exists
  --uid <uid>            continue only this incarnation — 404 otherwise
  --no-wait              print the 202 admission and exit
  --read <submissionId>  re-attach: wait for an earlier submission and print its reply
  --history              print the conversation transcript and exit
  --all                  with --history, include hidden/diagnostic messages
  --abort                abort in-flight and queued work, then exit
  --token <token>        bearer token (default: $FLUE_TOKEN)
  --token-env <VAR>      read the bearer token from this environment variable
  -H, --header <k: v>    extra request header (repeatable)
  --timeout <seconds>    max time to wait for settlement (default 600)
  --json                 print one JSON envelope instead of the reply text
  --quiet                no progress output on stderr

Exit codes: 0 completed · 1 failed · 130 aborted · 124 wait timed out (the
submission keeps running; re-attach with --read) · 2 usage or HTTP error.`;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		message: { type: 'string', short: 'm' },
		signal: { type: 'string' },
		attr: { type: 'string', multiple: true },
		'tag-name': { type: 'string' },
		data: { type: 'string' },
		new: { type: 'boolean' },
		uid: { type: 'string' },
		'no-wait': { type: 'boolean' },
		read: { type: 'string' },
		history: { type: 'boolean' },
		all: { type: 'boolean' },
		abort: { type: 'boolean' },
		token: { type: 'string' },
		'token-env': { type: 'string' },
		header: { type: 'string', short: 'H', multiple: true },
		timeout: { type: 'string' },
		json: { type: 'boolean' },
		quiet: { type: 'boolean' },
		help: { type: 'boolean', short: 'h' },
	},
});

if (values.help || positionals.length === 0) {
	console.error(USAGE);
	process.exit(values.help ? 0 : 2);
}

const url = positionals[0].replace(/\/+$/, '');
try {
	new URL(url);
} catch {
	fail(`not an absolute URL: ${url}`);
}
const timeoutMs = Number(values.timeout ?? 600) * 1000;
const headers = { 'content-type': 'application/json' };
const token = values['token-env'] ? process.env[values['token-env']] : (values.token ?? process.env.FLUE_TOKEN);
if (values['token-env'] && !token) fail(`environment variable ${values['token-env']} is not set`);
if (token) headers.authorization = `Bearer ${token}`;
for (const header of values.header ?? []) {
	const colon = header.indexOf(':');
	if (colon <= 0) fail(`bad header (expected "Name: value"): ${header}`);
	headers[header.slice(0, colon).trim().toLowerCase()] = header.slice(colon + 1).trim();
}
const progress = values.quiet || values.json ? () => {} : (text) => process.stderr.write(text);
// Live text deltas only help a human watching a terminal; captured output
// (pipes, Claude's Bash tool) would otherwise show the reply twice.
const streamText = !values.quiet && !values.json && process.stderr.isTTY === true;

if (values.history) {
	const snapshot = await getHistory();
	if (values.json) console.log(JSON.stringify(snapshot, null, 2));
	else console.log(renderTranscript(snapshot, values.all));
	process.exit(0);
}

if (values.abort) {
	const res = await request('POST', `${url}/abort`);
	const body = await res.json();
	if (values.json) console.log(JSON.stringify(body));
	else console.log(body.aborted ? 'Abort recorded; in-flight and queued work will settle as aborted.' : 'Nothing to abort (the conversation was idle).');
	process.exit(0);
}

if (values.read) {
	await finish({ submissionId: values.read, offset: '-1' });
}

const text = values.message ?? positionals.slice(1).join(' ');
if (!text) fail('no message (use -m "..." or trailing words)');
const message = values.signal
	? {
			kind: 'signal',
			type: values.signal,
			body: text,
			...(values.attr?.length ? { attributes: Object.fromEntries(values.attr.map(parseAttribute)) } : {}),
			...(values['tag-name'] ? { tagName: values['tag-name'] } : {}),
		}
	: { kind: 'user', body: text };
const body = { ...message };
if (values.data !== undefined) {
	try {
		body.initialData = JSON.parse(values.data);
	} catch (err) {
		fail(`--data is not valid JSON: ${err.message}`);
	}
}
if (values.new) body.uid = null;
if (values.uid) body.uid = values.uid;

const res = await request('POST', url, body);
const admission = await res.json();
if (values['no-wait']) {
	console.log(JSON.stringify({ conversationUrl: url, ...admission }));
	process.exit(0);
}
progress(`▸ ${url}  submission ${admission.submissionId}\n`);
await finish({ submissionId: admission.submissionId, offset: admission.offset, uid: admission.uid });

// ─── protocol ────────────────────────────────────────────────────────────────

async function finish({ submissionId, offset, uid }) {
	const settlement = await waitForSettlement(submissionId, offset);
	const snapshot = await getHistory();
	const reply = readSubmissionReply(snapshot, submissionId);
	const envelope = {
		conversationUrl: url,
		submissionId,
		...(uid ? { uid } : {}),
		outcome: settlement.outcome,
		text: reply.text,
		data: reply.data,
		...(reply.metadata ? { metadata: reply.metadata } : {}),
		...(settlement.error !== undefined ? { error: settlement.error } : {}),
	};
	if (values.json) console.log(JSON.stringify(envelope, null, 2));
	else {
		progress('\n');
		if (reply.text) console.log(reply.text);
		if (settlement.outcome !== 'completed') {
			const detail = settlement.error ? `: ${describeError(settlement.error)}` : '';
			console.error(`✗ submission ${settlement.outcome}${detail}`);
		}
	}
	process.exit(settlement.outcome === 'completed' ? 0 : settlement.outcome === 'aborted' ? 130 : 1);
}

async function waitForSettlement(submissionId, startOffset) {
	const deadline = Date.now() + timeoutMs;
	let offset = startOffset;
	let last = { batch: -1, index: -1 };
	let streamingText = false;
	while (Date.now() < deadline) {
		const res = await request('GET', `${url}?view=updates&offset=${encodeURIComponent(offset)}&live=long-poll`);
		const chunks = await res.json();
		offset = res.headers.get('stream-next-offset') ?? offset;
		for (const chunk of chunks) {
			const position = chunk.position;
			if (position) {
				if (position.batch < last.batch || (position.batch === last.batch && position.index <= last.index)) continue;
				last = position;
			}
			switch (chunk.type) {
				case 'conversation-reset': {
					const settled = chunk.snapshot?.settlements?.find((entry) => entry.submissionId === submissionId);
					if (settled) return settled;
					break;
				}
				case 'message-delta':
					if (chunk.kind === 'text' && streamText) {
						if (!streamingText) progress('\n');
						streamingText = true;
						progress(chunk.delta);
					}
					break;
				case 'tool-input':
					streamingText = false;
					progress(`\n  → ${chunk.toolName}(${truncate(JSON.stringify(chunk.input ?? {}), 160)})`);
					break;
				case 'tool-output':
					progress(`\n  ✓ ${truncate(JSON.stringify(chunk.output ?? null), 160)}${chunk.durationMs ? ` (${chunk.durationMs}ms)` : ''}`);
					break;
				case 'tool-output-error':
					progress(`\n  ✗ ${truncate(chunk.errorText ?? '', 240)}`);
					break;
				case 'data-part':
					progress(`\n  ▣ data-${chunk.name}: ${truncate(JSON.stringify(chunk.data ?? null), 160)}`);
					break;
				case 'submission-settled':
					if (chunk.submissionId === submissionId) return chunk;
					break;
				default:
					break;
			}
		}
	}
	const hint = `still running — re-attach with: flue-talk.mjs ${url} --read ${submissionId}`;
	if (values.json) console.log(JSON.stringify({ conversationUrl: url, submissionId, outcome: 'timeout', hint }));
	else console.error(`\n⏱ gave up waiting after ${timeoutMs / 1000}s; ${hint}`);
	process.exit(124);
}

async function getHistory() {
	const res = await request('GET', url);
	return res.json();
}

async function request(method, target, json) {
	let res;
	try {
		res = await fetch(target, {
			method,
			headers,
			...(json !== undefined ? { body: JSON.stringify(json) } : {}),
		});
	} catch (err) {
		const cause = err?.cause?.code ?? err?.cause?.message ?? err.message;
		fail(`cannot reach ${target} (${cause}). Is the server running (\`vite dev\` / deployed URL)?`);
	}
	if (res.ok) return res;
	const raw = await res.text().catch(() => '');
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {}
	const envelope = parsed?.error;
	if (envelope?.type) {
		const hints = {
			stream_not_found: 'the conversation has not received a message yet',
			agent_instance_exists: `it already exists${envelope.meta?.uid ? ` — continue with --uid ${envelope.meta.uid}` : ''}`,
			agent_instance_not_found: 'no instance with that id/uid — drop --uid to create or continue unconditionally',
			runtime_unavailable: 'the dev runtime is reloading; retry in a second',
		};
		fail(`HTTP ${res.status} [${envelope.type}] ${envelope.message}${envelope.details ? ` — ${envelope.details}` : ''}${hints[envelope.type] ? ` (${hints[envelope.type]})` : ''}${envelope.dev ? `\n  dev: ${envelope.dev}` : ''}`);
	}
	if (res.status === 404) {
		fail(`HTTP 404 from ${target} with no Flue error envelope — nothing is mounted there. Check the mount path in app.ts (app.route('<path>', createAgentRouter(Agent))) and append a conversation id.`);
	}
	fail(`HTTP ${res.status} ${res.statusText} from ${target}${raw ? `: ${truncate(raw, 400)}` : ''}`);
}

// Mirrors readSubmissionReply() from @flue/sdk: the submission's final
// assistant message, else the message that answered it when it joined a
// busy response, else the conversation's last assistant message.
function readSubmissionReply(snapshot, submissionId) {
	const assistant = (snapshot.messages ?? []).filter((message) => message.role === 'assistant');
	let reply = assistant.filter((message) => message.submissionId === submissionId).at(-1);
	if (!reply) {
		const settlement = snapshot.settlements?.find((entry) => entry.submissionId === submissionId);
		reply =
			settlement?.answeredBySubmissionId !== undefined
				? assistant.filter((message) => message.submissionId === settlement.answeredBySubmissionId).at(-1)
				: assistant.at(-1);
	}
	if (!reply) return { text: '', data: {} };
	const data = {};
	for (const part of reply.parts) {
		if (!part.type.startsWith('data-')) continue;
		(data[part.type.slice(5)] ??= []).push(part.data);
	}
	return {
		text: reply.parts
			.filter((part) => part.type === 'text')
			.map((part) => part.text)
			.join('\n\n'),
		data,
		...(reply.metadata !== undefined ? { metadata: reply.metadata } : {}),
	};
}

function renderTranscript(snapshot, all) {
	const lines = [`${url}  (${snapshot.messages?.length ?? 0} messages)`];
	for (const message of snapshot.messages ?? []) {
		if (!all && message.display !== 'visible') continue;
		const signal = message.signal ? ` <${message.signal.tagName ?? 'signal'}${Object.entries(message.signal.attributes ?? {}).map(([k, v]) => ` ${k}="${v}"`).join('')}>` : '';
		lines.push('', `${message.role} [${message.purpose}${message.display === 'visible' ? '' : `, ${message.display}`}]${signal}`);
		for (const part of message.parts) {
			if (part.type === 'text') lines.push(`  ${part.text.replace(/\n/g, '\n  ')}`);
			else if (part.type === 'reasoning') lines.push(`  (reasoning, ${part.text.length} chars)`);
			else if (part.type === 'dynamic-tool') {
				const outcome =
					part.state === 'output-available'
						? `✓ ${truncate(JSON.stringify(part.output ?? null), 120)}`
						: part.state === 'output-error'
							? `✗ ${truncate(part.errorText, 160)}`
							: '… pending';
				lines.push(`  → ${part.toolName}(${truncate(JSON.stringify(part.input ?? {}), 120)}) ${outcome}`);
			} else if (part.type === 'file') lines.push(`  [file ${part.filename ?? part.id ?? ''} ${part.mediaType}]`);
			else if (part.type.startsWith('data-')) lines.push(`  ▣ ${part.type}: ${truncate(JSON.stringify(part.data ?? null), 120)}`);
		}
	}
	const settlements = snapshot.settlements ?? [];
	if (settlements.length > 0) {
		lines.push('', 'settlements:');
		for (const s of settlements) lines.push(`  ${s.submissionId} ${s.outcome}${s.error ? ` — ${describeError(s.error)}` : ''}`);
	}
	return lines.join('\n');
}

function describeError(error) {
	if (typeof error !== 'object' || error === null) return String(error);
	return [error.type ? `[${error.type}]` : '', error.message ?? '', error.details ? `— ${error.details}` : ''].filter(Boolean).join(' ');
}

function parseAttribute(pair) {
	const eq = pair.indexOf('=');
	if (eq <= 0) fail(`bad --attr (expected key=value): ${pair}`);
	return [pair.slice(0, eq), pair.slice(eq + 1)];
}

function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fail(message) {
	console.error(`flue-talk: ${message}`);
	process.exit(2);
}
