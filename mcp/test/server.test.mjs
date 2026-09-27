// End-to-end tests: drive the built server (dist/server.mjs) over stdio with
// real MCP clients against the deterministic Flue fixture in eval/fixture.
//
//   pnpm build && (cd eval/fixture && npm install) && pnpm test
//
// The fixture's agents use faux models, so no API keys are needed. Live tests
// are skipped (with a reason) when the fixture's dependencies aren't installed.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as V1StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '..', 'dist', 'server.mjs');
const FIXTURE = join(here, '..', 'eval', 'fixture');
const FIXTURE_READY = existsSync(join(FIXTURE, 'node_modules', '@flue', 'vite'));
const TOKEN = 'open-sesame';

assert.ok(existsSync(SERVER), 'dist/server.mjs is missing — run `pnpm build` first');

async function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function waitFor(url, ms) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		try {
			await fetch(url);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(`timed out waiting for ${url}`);
}

function text(result) {
	return result.content?.map((part) => part.text ?? '').join('\n') ?? '';
}

let home;
let baseUrl;
let fixture;
let client;

async function call(name, args, options) {
	return client.callTool({ name, arguments: args }, options);
}

before(async () => {
	home = mkdtempSync(join(tmpdir(), 'flue-loom-mcp-test-'));
	if (FIXTURE_READY) {
		const port = await freePort();
		baseUrl = `http://localhost:${port}`;
		fixture = spawn(process.execPath, [join(FIXTURE, 'node_modules', 'vite', 'bin', 'vite.js'), 'dev', '--port', String(port), '--strictPort'], {
			cwd: FIXTURE,
			env: { ...process.env, VAULT_TOKEN: TOKEN },
			stdio: 'ignore',
		});
		await waitFor(`${baseUrl}/`, 30_000);
	} else {
		baseUrl = `http://localhost:${await freePort()}`; // nothing listens here
	}
	client = new Client({ name: 'flue-loom-test', version: '0.0.0' });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [SERVER],
			env: { ...process.env, FLUE_LOOM_HOME: home, FLUE_LOOM_PROJECT_DIR: FIXTURE, FLUE_LOOM_BASE_URL: baseUrl, FLUE_FIXTURE_TOKEN: TOKEN },
			stderr: 'ignore',
		}),
	);
});

after(async () => {
	await client?.close();
	fixture?.kill();
	rmSync(home, { recursive: true, force: true });
});

describe('static', () => {
	it('lists the seven tools with annotations and output schemas', async () => {
		const { tools } = await client.listTools();
		const names = tools.map((tool) => tool.name).sort();
		assert.deepEqual(names, ['flue_abort', 'flue_add_agent', 'flue_get_conversation', 'flue_list_agents', 'flue_read_reply', 'flue_remove_agent', 'flue_send_message']);
		for (const tool of tools) {
			assert.ok(tool.outputSchema, `${tool.name} has an outputSchema`);
			assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} has annotations`);
		}
	});

	it('discovers the fixture mounts from app.ts', async () => {
		const result = await call('flue_list_agents', {});
		assert.equal(result.isError, undefined);
		const agents = result.structuredContent.project.agents;
		assert.deepEqual(agents.map((agent) => agent.name).sort(), ['broken', 'calc', 'counter', 'echo', 'inbox', 'profile', 'slow', 'vault']);
		assert.equal(agents.find((agent) => agent.name === 'vault').url, `${baseUrl}/secure/vault`);
	});

	it('registers, persists, and removes agents without storing secrets', async () => {
		const added = await call('flue_add_agent', { name: 'vault-prod', url: `${baseUrl}/secure/vault/`, token_env: 'FLUE_FIXTURE_TOKEN', description: 'fixture vault' });
		assert.equal(added.isError, undefined, text(added));
		assert.equal(added.structuredContent.agent.url, `${baseUrl}/secure/vault`);
		assert.equal(added.structuredContent.agent.credentials, 'FLUE_FIXTURE_TOKEN set');
		const stored = readFileSync(join(home, 'agents.json'), 'utf-8');
		assert.ok(!stored.includes(TOKEN), 'the token value is never written');
		const listed = await call('flue_list_agents', {});
		assert.equal(listed.structuredContent.registered.length, 1);
		const removed = await call('flue_remove_agent', { name: 'vault-prod' });
		assert.equal(removed.structuredContent.removed, true);
		const again = await call('flue_remove_agent', { name: 'vault-prod' });
		assert.equal(again.structuredContent.removed, false);
	});

	it('refuses credential variables outside FLUE_*', async () => {
		const result = await call('flue_add_agent', { name: 'leak', url: 'https://example.com/agents/x', token_env: 'AWS_SECRET_ACCESS_KEY' });
		assert.equal(result.isError, true);
		assert.match(text(result), /FLUE_\*/);
	});

	it('explains addressing mistakes without structuredContent', async () => {
		const unknown = await call('flue_send_message', { agent: 'nope', message: 'hi' });
		assert.equal(unknown.isError, true);
		assert.equal(unknown.structuredContent, undefined);
		assert.match(text(unknown), /No agent named "nope"/);
		const both = await call('flue_send_message', { agent: 'echo', url: '/agents/echo', message: 'hi' });
		assert.match(text(both), /only one of/);
		const noConversation = await call('flue_get_conversation', { agent: 'echo' });
		assert.match(text(noConversation), /conversation_id/);
	});

	it('reports an unreachable server clearly', async () => {
		const port = await freePort();
		const result = await call('flue_send_message', { url: `http://localhost:${port}/agents/echo`, message: 'hi' });
		assert.equal(result.isError, true);
		assert.match(text(result), /Could not reach http:\/\/localhost:\d+ \(ECONNREFUSED\)/);
	});
});

describe('live fixture', { skip: FIXTURE_READY ? false : 'eval/fixture dependencies not installed (cd eval/fixture && npm install)' }, () => {
	it('sends, waits, and reports tool activity, data parts, and progress', async () => {
		const progress = [];
		const result = await call('flue_send_message', { agent: 'calc', message: 'add 17 and 25' }, { onprogress: (update) => progress.push(update.message) });
		assert.equal(result.isError, undefined, text(result));
		const out = result.structuredContent;
		assert.equal(out.outcome, 'completed');
		assert.equal(out.text, 'The sum is 42.');
		assert.deepEqual(out.activity.map((entry) => [entry.tool, entry.status]), [['add', 'ok']]);
		assert.deepEqual(out.data.progress, [{ step: 'adding 17 and 25' }]);
		assert.match(out.conversation_id, /^mcp-/);
		assert.ok(progress.includes('tool add started'), `progress: ${progress.join(' | ')}`);
	});

	it('continues a conversation by id', async () => {
		let last;
		for (let i = 0; i < 3; i += 1) last = await call('flue_send_message', { agent: 'counter', conversation_id: 'count-1', message: 'tick' });
		assert.equal(last.structuredContent.text, 'count: 3');
		const history = await call('flue_get_conversation', { agent: 'counter', conversation_id: 'count-1' });
		assert.equal(history.structuredContent.exists, true);
		assert.equal(history.structuredContent.message_count, 6);
		assert.equal(history.structuredContent.settlements.length, 3);
		assert.equal(history.structuredContent.messages.at(-1).tool_calls[0].tool, 'increment');
	});

	it('returns pending on timeout and re-attaches with flue_read_reply', async () => {
		const sent = await call('flue_send_message', { agent: 'slow', conversation_id: 'slow-1', message: 'wait 2500', timeout_seconds: 1 });
		assert.equal(sent.structuredContent.outcome, 'pending');
		const read = await call('flue_read_reply', { agent: 'slow', conversation_id: 'slow-1', submission_id: sent.structuredContent.submission_id, timeout_seconds: 30 });
		assert.equal(read.structuredContent.outcome, 'completed');
		assert.equal(read.structuredContent.text, 'waited 2500 ms');
	});

	it('aborts running work', async () => {
		const sent = await call('flue_send_message', { agent: 'slow', conversation_id: 'slow-2', message: 'wait 30000', wait: false });
		assert.equal(sent.structuredContent.outcome, 'pending');
		await new Promise((resolve) => setTimeout(resolve, 500));
		const aborted = await call('flue_abort', { agent: 'slow', conversation_id: 'slow-2' });
		assert.equal(aborted.structuredContent.aborted, true);
		const read = await call('flue_read_reply', { agent: 'slow', conversation_id: 'slow-2', submission_id: sent.structuredContent.submission_id, timeout_seconds: 30 });
		assert.equal(read.isError, true);
		assert.match(text(read), /was aborted/);
		const idle = await call('flue_abort', { agent: 'slow', conversation_id: 'slow-2' });
		assert.equal(idle.structuredContent.aborted, false);
	});

	it('passes creation data and surfaces schema rejections', async () => {
		const ok = await call('flue_send_message', { agent: 'profile', conversation_id: 'ada', message: 'hi', initial_data: { name: 'Ada', plan: 'pro' } });
		assert.equal(ok.structuredContent.text, 'Hello Ada, you are on the pro plan.');
		const bad = await call('flue_send_message', { agent: 'profile', conversation_id: 'bob', message: 'hi', initial_data: { name: 'Bob', plan: 'gold' } });
		assert.equal(bad.isError, true);
		assert.match(text(bad), /invalid_request/);
	});

	it('delivers signals with attributes', async () => {
		const result = await call('flue_send_message', { url: '/agents/inbox', conversation_id: 'ops', message: 'v2.1', signal_type: 'deploy', attributes: { env: 'staging' } });
		assert.equal(result.structuredContent.text, 'received signal deploy (env=staging): v2.1');
	});

	it('reports failed submissions with the error type', async () => {
		const result = await call('flue_send_message', { agent: 'broken', message: 'hi' });
		assert.equal(result.isError, true);
		assert.match(text(result), /failed \(operation_failed\): .*upstream model unavailable/);
	});

	it('explains 401s and sends registered credentials', async () => {
		const denied = await call('flue_send_message', { agent: 'vault', message: 'secret?' });
		assert.equal(denied.isError, true);
		assert.match(text(denied), /refused the request \(401/);
		await call('flue_add_agent', { name: 'vault-auth', url: `${baseUrl}/secure/vault`, token_env: 'FLUE_FIXTURE_TOKEN' });
		const allowed = await call('flue_send_message', { agent: 'vault-auth', message: 'secret?' });
		assert.equal(allowed.structuredContent.text, 'The secret word is marmalade.');
		// A discovered name at the same mount picks up the registered credentials too.
		const byMount = await call('flue_send_message', { agent: 'vault', message: 'again?' });
		assert.equal(byMount.structuredContent.text, 'The secret word is marmalade.');
		await call('flue_remove_agent', { name: 'vault-auth' });
	});

	it('explains 404s, conflicts, and missing conversations', async () => {
		const unmounted = await call('flue_send_message', { url: '/nowhere', message: 'hi' });
		assert.match(text(unmounted), /Nothing is mounted at/);
		await call('flue_send_message', { agent: 'echo', conversation_id: 'exists-1', message: 'first' });
		const conflict = await call('flue_send_message', { agent: 'echo', conversation_id: 'exists-1', message: 'again', create_only: true });
		assert.match(text(conflict), /agent_instance_exists/);
		const missing = await call('flue_get_conversation', { agent: 'echo', conversation_id: 'never-created' });
		assert.equal(missing.isError, undefined);
		assert.equal(missing.structuredContent.exists, false);
	});

	it('deduplicates retried sends with an idempotency key', async () => {
		const first = await call('flue_send_message', { agent: 'echo', conversation_id: 'idem', message: 'once', idempotency_key: 'k-1' });
		const second = await call('flue_send_message', { agent: 'echo', conversation_id: 'idem', message: 'once', idempotency_key: 'k-1' });
		assert.equal(second.structuredContent.submission_id, first.structuredContent.submission_id);
		assert.equal(second.structuredContent.deduplicated, true);
		assert.equal(second.structuredContent.text, 'echo: once');
	});

	it('works with a v1 SDK client, including error results', async () => {
		const v1 = new V1Client({ name: 'flue-loom-test-v1', version: '0.0.0' });
		await v1.connect(
			new V1StdioClientTransport({
				command: process.execPath,
				args: [SERVER],
				env: { ...process.env, FLUE_LOOM_HOME: home, FLUE_LOOM_PROJECT_DIR: FIXTURE, FLUE_LOOM_BASE_URL: baseUrl },
				stderr: 'ignore',
			}),
		);
		try {
			const ok = await v1.callTool({ name: 'flue_send_message', arguments: { agent: 'echo', message: 'from v1' } });
			assert.equal(ok.structuredContent.text, 'echo: from v1');
			const failed = await v1.callTool({ name: 'flue_send_message', arguments: { agent: 'broken', message: 'hi' } });
			assert.equal(failed.isError, true);
		} finally {
			await v1.close();
		}
	});
});
