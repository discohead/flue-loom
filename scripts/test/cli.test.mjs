// The hook entry points and CLI helpers, run as child processes the way
// Claude Code (and Claude) run them.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanup, project } from './helpers.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(scripts, '..', 'mcp', 'eval', 'fixture');
const fixtureInstalled = fs.existsSync(path.join(fixture, 'node_modules', '@flue', 'vite'));

function run(script, args = [], { input, cwd, env } = {}) {
	const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
		input,
		cwd,
		env: { ...process.env, FLUE_LOOM_NO_PROJECT_SCANNER: '1', ...env },
		encoding: 'utf8',
		timeout: 60_000,
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('lint-flue-file.mjs (PostToolUse hook)', () => {
	let root;
	before(() => {
		root = project({
			'src/agents/bad.ts': "import { useModel } from '@flue/runtime';\n'use agent';\nexport function Bad() { useModel('a/b'); return ''; }\n",
			'src/agents/good.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Good() { useModel('a/b'); return ''; }\n",
			'src/app.ts': "app.route('/agents/good', createAgentRouter(Good));\n",
		});
	});
	after(() => cleanup(root));

	it('returns findings as PostToolUse additionalContext', () => {
		const { code, stdout } = run('lint-flue-file.mjs', [], { input: JSON.stringify({ cwd: root, tool_name: 'Write', tool_input: { file_path: 'src/agents/bad.ts' } }) });
		assert.equal(code, 0);
		const output = JSON.parse(stdout);
		assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
		assert.match(output.hookSpecificOutput.additionalContext, /flue-loom lint · src\/agents\/bad\.ts/);
		assert.match(output.hookSpecificOutput.additionalContext, /directive prologue/);
	});
	it('stays silent for clean files and files outside Flue projects', () => {
		assert.equal(run('lint-flue-file.mjs', [], { input: JSON.stringify({ cwd: root, tool_input: { file_path: path.join(root, 'src/agents/good.ts') } }) }).stdout, '');
		assert.equal(run('lint-flue-file.mjs', [], { input: JSON.stringify({ cwd: '/', tool_input: { file_path: '/etc/hostname' } }) }).stdout, '');
	});
	it('never fails the edit on malformed input', () => {
		const { code, stdout, stderr } = run('lint-flue-file.mjs', [], { input: 'not json' });
		assert.equal(code, 0);
		assert.equal(stdout, '');
		assert.match(stderr, /malformed hook input/);
	});
});

describe('session-start.mjs (SessionStart hook)', () => {
	let root;
	let legacy;
	before(() => {
		root = project({
			'flue.config.ts': "export default { target: 'node' };",
			'src/app.ts': "app.route('/agents/support', createAgentRouter(Support));\n",
			'src/agents/support.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Support() { useModel('a/b'); return ''; }\n",
		});
		legacy = project({ '.flue/agents/hello.ts': "import type { FlueContext } from '@flue/sdk/client';\nexport const triggers = { webhook: true };\n" }, { deps: { '@flue/sdk': '^0.3.5' } });
	});
	after(() => {
		cleanup(root);
		cleanup(legacy);
	});

	it('maps a Flue 2 project', () => {
		const { code, stdout } = run('session-start.mjs', [], { input: JSON.stringify({ cwd: root, source: 'startup' }) });
		assert.equal(code, 0);
		const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
		assert.match(context, /Support/);
		assert.match(context, /\/agents\/support/);
	});
	it('flags a misplaced directive and a mount with no agent behind it', () => {
		const broken = project({
			'src/app.ts': "app.route('/agents/support', createAgentRouter(Support));\n",
			'src/agents/support.ts': "import { useModel } from '@flue/runtime';\n'use agent';\nexport function Support() { useModel('a/b'); return ''; }\n",
		});
		try {
			const context = JSON.parse(run('session-start.mjs', [], { input: JSON.stringify({ cwd: broken }) }).stdout).hookSpecificOutput.additionalContext;
			assert.match(context, /Not registered — `'use agent'` is below other statements in src\/agents\/support\.ts/);
			assert.match(context, /mounts Support \(\/agents\/support\), which no 'use agent' module exports/);
		} finally {
			cleanup(broken);
		}
	});
	it('recommends migrating a pre-2.0 project', () => {
		const context = JSON.parse(run('session-start.mjs', [], { input: JSON.stringify({ cwd: legacy }) }).stdout).hookSpecificOutput.additionalContext;
		assert.match(context, /\/flue-loom:migrate/);
	});
	it('is silent outside Flue projects', () => {
		const empty = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'flue-loom-empty-'));
		try {
			assert.equal(run('session-start.mjs', [], { input: JSON.stringify({ cwd: empty }) }).stdout, '');
		} finally {
			cleanup(empty);
		}
	});
});

describe('flue-inspect.mjs', () => {
	it('reports agents, mounts, and lint as JSON', () => {
		const root = project({
			'src/app.ts': "app.route('/agents/support', createAgentRouter(Support));\n",
			'src/agents/support.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Support() { useModel('a/b'); return ''; }\n",
		});
		try {
			const { code, stdout } = run('flue-inspect.mjs', [root, '--json']);
			assert.equal(code, 0);
			const [info] = JSON.parse(stdout).projects;
			assert.deepEqual(info.agents.map((agent) => [agent.identity, agent.mount]), [['Support', '/agents/support']]);
		} finally {
			cleanup(root);
		}
	});
});

describe('flue-models.mjs', { skip: fixtureInstalled ? false : 'mcp/eval/fixture not installed' }, () => {
	it('validates ids against the installed catalog and suggests fixes', () => {
		assert.equal(run('flue-models.mjs', ['--check', 'anthropic/claude-haiku-4-5', '--project', fixture]).code, 0);
		const typo = run('flue-models.mjs', ['--check', 'anthropic/claude-haiku-4.5', '--project', fixture]);
		assert.equal(typo.code, 1);
		assert.match(typo.stdout + typo.stderr, /anthropic\/claude-haiku-4-5/);
	});
});

describe('flue-talk.mjs', { skip: fixtureInstalled ? false : 'mcp/eval/fixture not installed' }, () => {
	let server;
	let base;
	before(async () => {
		const port = await new Promise((resolve) => {
			const probe = createServer().listen(0, () => {
				const { port: free } = probe.address();
				probe.close(() => resolve(free));
			});
		});
		base = `http://localhost:${port}`;
		server = spawn(process.execPath, [path.join(fixture, 'node_modules', 'vite', 'bin', 'vite.js'), 'dev', '--port', String(port), '--strictPort'], { cwd: fixture, stdio: 'ignore' });
		for (let i = 0; i < 120; i += 1) {
			try {
				await fetch(base);
				return;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
		throw new Error('fixture dev server did not start');
	});
	after(() => server?.kill());

	const talk = (args) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [path.join(scripts, 'flue-talk.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk) => (stdout += chunk));
			child.stderr.on('data', (chunk) => (stderr += chunk));
			child.on('close', (code) => resolve({ code, stdout, stderr }));
		});

	it('sends a message and prints the reply', async () => {
		const { code, stdout, stderr } = await talk([`${base}/agents/calc/talk-1`, '-m', 'add 2 and 3']);
		assert.equal(code, 0, stderr);
		assert.equal(stdout.trim(), 'The sum is 5.');
		assert.match(stderr, /add/);
	});
	it('prints a JSON envelope and delivers signals', async () => {
		const { code, stdout } = await talk([`${base}/agents/inbox/talk-2`, '--signal', 'deploy', '--attr', 'env=prod', '--json', 'v1']);
		assert.equal(code, 0);
		const envelope = JSON.parse(stdout);
		assert.equal(envelope.text, 'received signal deploy (env=prod): v1');
	});
	it('re-attaches with --read and prints history', async () => {
		const admitted = JSON.parse((await talk([`${base}/agents/slow/talk-3`, '-m', 'wait 300', '--no-wait'])).stdout);
		const read = await talk([`${base}/agents/slow/talk-3`, '--read', admitted.submissionId]);
		assert.equal(read.stdout.trim(), 'waited 300 ms');
		const history = await talk([`${base}/agents/slow/talk-3`, '--history']);
		assert.match(history.stdout, /waited 300 ms/);
	});
	it('fails clearly on an unmounted path and a failing agent', async () => {
		const missing = await talk([`${base}/nowhere/x`, '-m', 'hi']);
		assert.equal(missing.code, 2);
		assert.match(missing.stderr, /mount/i);
		const broken = await talk([`${base}/agents/broken/talk-4`, '-m', 'hi']);
		assert.equal(broken.code, 1);
		assert.match(broken.stderr, /operation_failed|upstream model unavailable/);
	});
});
