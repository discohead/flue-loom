// Edit-time lint, heuristic mode (the throwaway projects have no node_modules),
// plus parity with the real @flue/vite scanner when the MCP eval fixture is installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatFindings, lintFile } from '../lib/lint.mjs';
import { cleanup, messages, project } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function lint(root, rel) {
	return (await lintFile(root, path.join(root, rel))).findings;
}

describe('agent modules (heuristic)', () => {
	let root;
	before(() => {
		process.env.FLUE_LOOM_NO_PROJECT_SCANNER = '1';
		root = project({
			'src/app.ts': "import { Good } from './agents/good.ts';\napp.route('/agents/good', createAgentRouter(Good));\n",
			'src/agents/good.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Good() {\n\tuseModel('anthropic/claude-haiku-4-5');\n\treturn 'hi';\n}\n",
			'src/agents/misplaced.ts': "import { useModel } from '@flue/runtime';\n'use agent';\nexport function Misplaced() { useModel('a/b'); return ''; }\n",
			'src/agents/undirected.ts': "import { useModel } from '@flue/runtime';\nexport function Undirected() { useModel('a/b'); return ''; }\n",
			'src/agents/async.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport async function Slow() { useModel('a/b'); return ''; }\n",
			'src/agents/bad-name.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Bad() { useModel('a/b'); return ''; }\nBad.agentName = 'bad_name';\n",
			'src/agents/empty.ts': "'use agent';\nexport function helper() {}\n",
			'src/agents/unmounted.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Lonely() { useModel('a/b'); return ''; }\n",
			'src/agents/legacy.ts': "import type { FlueContext } from '@flue/sdk/client';\nexport const triggers = { webhook: true };\nexport default async function ({ init }: FlueContext) {}\n",
		});
	});
	after(() => {
		cleanup(root);
		delete process.env.FLUE_LOOM_NO_PROJECT_SCANNER;
	});

	it('passes a well-formed, mounted agent', async () => {
		assert.deepEqual(await lint(root, 'src/agents/good.ts'), []);
	});
	it('catches a directive below the imports', async () => {
		assert.match(messages(await lint(root, 'src/agents/misplaced.ts')).join('\n'), /^error: .*not in the directive prologue/m);
	});
	it('warns about a useModel() agent without the directive', async () => {
		assert.match(messages(await lint(root, 'src/agents/undirected.ts')).join('\n'), /^warn: .*no `'use agent'` directive/m);
	});
	it('rejects async agents', async () => {
		assert.match(messages(await lint(root, 'src/agents/async.ts')).join('\n'), /^error: `Slow` is async/m);
	});
	it('rejects invalid identities', async () => {
		assert.match(messages(await lint(root, 'src/agents/bad-name.ts')).join('\n'), /^error: Agent identity "bad_name" is invalid/m);
	});
	it('rejects duplicate and colliding identities across the project', async () => {
		const other = project({
			'src/agents/a.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Good() { useModel('a/b'); return ''; }\n",
			'src/agents/b.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Other() { useModel('a/b'); return ''; }\nOther.agentName = 'Good';\n",
			'src/agents/c.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function IssueTriage() { useModel('a/b'); return ''; }\n",
			'src/agents/d.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Triage() { useModel('a/b'); return ''; }\nTriage.agentName = 'issue-triage';\n",
		});
		try {
			assert.match(messages(await lint(other, 'src/agents/b.ts')).join('\n'), /^error: Duplicate agent identity "Good" — also exported by src\/agents\/a\.ts/m);
			assert.match(messages(await lint(other, 'src/agents/d.ts')).join('\n'), /fold to the same generated Durable Object name \(FlueIssueTriageAgent/);
		} finally {
			cleanup(other);
		}
	});
	it('rejects a marked module without agents', async () => {
		assert.match(messages(await lint(root, 'src/agents/empty.ts')).join('\n'), /exports no agents/);
	});
	it('hints at unmounted agents', async () => {
		assert.match(messages(await lint(root, 'src/agents/unmounted.ts')).join('\n'), /^info: `Lonely` is registered but neither mounted/m);
	});
	it('flags pre-2.0 APIs', async () => {
		const found = messages(await lint(root, 'src/agents/legacy.ts')).join('\n');
		assert.match(found, /Pre-2.0 API: `export const triggers`/);
		assert.match(found, /Pre-2.0 API: `FlueContext` handlers/);
		assert.match(found, /Pre-2.0 API: `@flue\/sdk\/client`/);
	});
	it('ignores node_modules and dist', async () => {
		assert.deepEqual((await lintFile(root, path.join(root, 'node_modules', 'x', 'index.ts'))).findings, []);
		assert.deepEqual((await lintFile(root, path.join(root, 'dist', 'server.mjs'))).findings, []);
	});
	it('formats findings for the hook', () => {
		const text = formatFindings('src/a.ts', [{ level: 'error', message: 'boom' }, { level: 'warn', message: 'hmm' }], 'heuristic');
		assert.match(text, /^flue-loom lint · src\/a\.ts \(heuristic\)/);
		assert.match(text, /✗ \[error\] boom/);
		assert.match(text, /⚠ \[warn\] hmm/);
	});
});

describe('Cloudflare wiring', () => {
	let root;
	before(() => {
		process.env.FLUE_LOOM_NO_PROJECT_SCANNER = '1';
		root = project({
			'flue.config.ts': "import { defineConfig } from '@flue/runtime/config';\nexport default defineConfig({ target: 'cloudflare' });\n",
			'wrangler.jsonc': '{\n // comment\n "name": "w",\n "compatibility_date": "2025-01-01",\n "durable_objects": { "bindings": [{ "name": "FLUE_HELLO_AGENT", "class_name": "FlueHelloAgent" }] },\n "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlueHelloAgent"] }, { "tag": "v1", "new_classes": ["FlueOldAgent"] }],\n}\n',
			'vite.config.ts': "import { cloudflare } from '@cloudflare/vite-plugin';\nimport { flue } from '@flue/vite';\nexport default { plugins: [cloudflare(), flue()] };\n",
			'src/app.ts': "app.route('/agents/hello', createAgentRouter(Hello));\napp.route('/agents/triage', createAgentRouter(Triage));\n",
			'src/agents/hello.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Hello() { useModel('a/b'); return ''; }\n",
			'src/agents/triage.ts': "'use agent';\nimport { useModel } from '@flue/runtime';\nexport function Triage() { useModel('a/b'); return ''; }\n",
		});
	});
	after(() => {
		cleanup(root);
		delete process.env.FLUE_LOOM_NO_PROJECT_SCANNER;
	});

	it('reports a missing migration with the entry to add', async () => {
		const found = messages(await lint(root, 'src/agents/triage.ts')).join('\n');
		assert.match(found, /^warn: wrangler\.jsonc has no Durable Object migration for FlueTriageAgent/m);
		assert.match(found, /\{ "tag": "v\d+", "new_sqlite_classes": \["FlueTriageAgent"\] \}/);
		assert.doesNotMatch(messages(await lint(root, 'src/agents/hello.ts')).join('\n'), /no Durable Object migration/);
	});
	it('validates wrangler.jsonc', async () => {
		const found = messages(await lint(root, 'wrangler.jsonc')).join('\n');
		assert.match(found, /compatibility_date "2025-01-01" is older than 2026-04-01/);
		assert.match(found, /FLUE_HELLO_AGENT" uses a Flue-reserved name/);
		assert.match(found, /Duplicate migration tag\(s\): v1/);
		assert.match(found, /FlueOldAgent is introduced with legacy `new_classes`/);
	});
	it('validates plugin order and the Worker config in vite.config', async () => {
		const found = messages(await lint(root, 'vite.config.ts')).join('\n');
		assert.match(found, /cloudflare\(\) is listed before flue\(\)/);
		assert.match(found, /flueWorkerConfig/);
	});
});

describe('configs and skills', () => {
	let root;
	before(() => {
		root = project({
			'flue.config.ts': "import { defineConfig } from '@flue/cli/config';\nexport default defineConfig({ target: 'edge', output: 'dist', root: '.flue', tracing: { enabled: true } });\n",
			'vite.config.ts': "export default { plugins: [] };\n",
			'src/skills/triage/SKILL.md': '---\nname: Triage_Notes\ndescription: \n---\nbody\n',
			'src/skills/good/SKILL.md': '---\nname: good\ndescription: Do good things. Use when asked.\n---\nbody\n',
			'src/skills/good/.env': 'SECRET=1',
		});
	});
	after(() => cleanup(root));

	it('checks flue.config fields and imports', async () => {
		const found = messages(await lint(root, 'flue.config.ts')).join('\n');
		assert.match(found, /@flue\/cli\/config/);
		assert.match(found, /`output` was retired/);
		assert.match(found, /`root` was retired/);
		assert.match(found, /Invalid target "edge"/);
		assert.doesNotMatch(found, /enabled/, 'nested keys are not top-level fields');
	});
	it('warns when vite.config has no flue()', async () => {
		assert.match(messages(await lint(root, 'vite.config.ts')).join('\n'), /No flue\(\) plugin/);
	});
	it('checks SKILL.md frontmatter and packaging', async () => {
		const bad = messages(await lint(root, 'src/skills/triage/SKILL.md')).join('\n');
		assert.match(bad, /Skill name "Triage_Notes" must be lowercase/);
		assert.match(bad, /non-empty `description`/);
		const secret = messages(await lint(root, 'src/skills/good/SKILL.md')).join('\n');
		assert.match(secret, /\.env looks like a secret/);
	});
});

describe('@flue/vite scanner parity', () => {
	const fixture = path.join(here, '..', '..', 'mcp', 'eval', 'fixture');
	const installed = fs.existsSync(path.join(fixture, 'node_modules', '@flue', 'vite'));

	it('uses the project scanner when @flue/vite is installed', { skip: installed ? false : 'mcp/eval/fixture not installed' }, async () => {
		const { findings, scanner } = await lintFile(fixture, path.join(fixture, 'src', 'agents', 'calc.ts'));
		assert.equal(scanner, '@flue/vite scanner');
		assert.deepEqual(findings, []);
	});
});
