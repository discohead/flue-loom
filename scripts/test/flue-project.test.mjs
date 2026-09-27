import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
	agentBindingName,
	agentClassName,
	collectAgentsHeuristic,
	detectTarget,
	findFlueProjectRoot,
	hasAgentDirective,
	migratedClasses,
	parseJsonc,
	readAppMounts,
	resolveSourceRoot,
} from '../lib/flue-project.mjs';
import { cleanup, project } from './helpers.mjs';

describe('hasAgentDirective', () => {
	const yes = [
		"'use agent';\nexport function A() {}",
		'"use agent"\nimport x from "y";',
		"// header comment\n/* block */\n'use agent';",
		"#!/usr/bin/env node\n'use agent';",
		"'use strict';\n'use agent';",
		"﻿'use agent';",
	];
	const no = [
		"import x from 'y';\n'use agent';",
		"export const a = 1;\n'use agent';",
		"'use agent'.length;",
		"'use agent'\n+ other",
		"'use agents';",
		"const s = 'use agent';",
		'',
	];
	for (const code of yes) it(`accepts ${JSON.stringify(code.slice(0, 40))}`, () => assert.equal(hasAgentDirective(code), true));
	for (const code of no) it(`rejects ${JSON.stringify(code.slice(0, 40))}`, () => assert.equal(hasAgentDirective(code), false));
});

describe('collectAgentsHeuristic', () => {
	it('finds exported capitalized functions and skips helpers', () => {
		const { agents, problems } = collectAgentsHeuristic(
			"'use agent';\nexport function Support() {}\nexport function helper() {}\nexport const Triage = () => 'x';\nfunction Hidden() {}\nexport { Hidden as Renamed };\n",
		);
		assert.deepEqual(agents.map((a) => a.identity).sort(), ['Renamed', 'Support', 'Triage']);
		assert.deepEqual(problems, []);
	});

	it('honors literal agentName statics and flags computed ones', () => {
		const pinned = collectAgentsHeuristic("export function Support() {}\nSupport.agentName = 'support-desk'; // pinned\n");
		assert.equal(pinned.agents[0].identity, 'support-desk');
		const computed = collectAgentsHeuristic('export function Support() {}\nSupport.agentName = prefix + "x";\n');
		assert.deepEqual(computed.problems, ['non-literal-agentName:Support']);
	});

	it('flags async agents and anonymous default exports', () => {
		assert.equal(collectAgentsHeuristic('export async function Slow() {}').agents[0].async, true);
		assert.deepEqual(collectAgentsHeuristic('export default function () {}').problems, ['anonymous-default']);
		assert.deepEqual(collectAgentsHeuristic('export default () => "x";').problems, ['anonymous-default']);
	});

	it('ignores re-exports', () => {
		assert.deepEqual(collectAgentsHeuristic("export { Support } from './support.ts';").agents, []);
	});
});

describe('Durable Object names', () => {
	it('derives class and binding names like @flue/vite', () => {
		assert.equal(agentClassName('SupportAgent'), 'FlueSupportAgentAgent');
		assert.equal(agentBindingName('SupportAgent'), 'FLUE_SUPPORT_AGENT_AGENT');
		assert.equal(agentClassName('issue-triage'), 'FlueIssueTriageAgent');
		assert.equal(agentBindingName('issue-triage'), 'FLUE_ISSUE_TRIAGE_AGENT');
		assert.equal(agentClassName('IssueTriage'), agentClassName('issue-triage'));
	});
});

describe('parseJsonc', () => {
	it('strips comments and trailing commas but not string contents', () => {
		const parsed = parseJsonc('{\n // line\n "url": "https://x.dev/a//b", /* block */ "list": [1, 2,],\n}');
		assert.deepEqual(parsed, { url: 'https://x.dev/a//b', list: [1, 2] });
	});
});

describe('migratedClasses', () => {
	it('tracks new, renamed, deleted, and legacy classes', () => {
		const { live, legacyKv, tags } = migratedClasses({
			migrations: [
				{ tag: 'v1', new_sqlite_classes: ['FlueAAgent', 'FlueBAgent'] },
				{ tag: 'v2', renamed_classes: [{ from: 'FlueBAgent', to: 'FlueCAgent' }], new_classes: ['Legacy'] },
				{ tag: 'v3', deleted_classes: ['FlueAAgent'] },
			],
		});
		assert.deepEqual([...live].sort(), ['FlueCAgent', 'Legacy']);
		assert.deepEqual([...legacyKv], ['Legacy']);
		assert.deepEqual(tags, ['v1', 'v2', 'v3']);
	});
});

describe('project discovery', () => {
	it('finds the root, source root, target, and app mounts', () => {
		const root = project({
			'flue.config.ts': "export default { target: 'cloudflare' };",
			'src/app.ts': "app.route('/agents/support', createAgentRouter(Support));\napp.route(\"/hooks/slack\", slack.route());\n",
			'src/agents/support.ts': "'use agent';\nexport function Support() {}",
		});
		try {
			assert.equal(findFlueProjectRoot(path.join(root, 'src', 'agents')), root);
			assert.equal(resolveSourceRoot(root), path.join(root, 'src'));
			assert.equal(detectTarget(root).target, 'cloudflare');
			const mounts = readAppMounts(path.join(root, 'src', 'app.ts'));
			assert.deepEqual(mounts.agents, [{ path: '/agents/support', agent: 'Support' }]);
			assert.deepEqual(mounts.channels, [{ path: '/hooks/slack', channel: 'slack' }]);
		} finally {
			cleanup(root);
		}
	});

	it('prefers .flue/ over src/ and ignores non-Flue packages', () => {
		const root = project({ '.flue/agents/a.ts': '', 'src/index.ts': '' });
		const plain = project({}, { deps: { react: '^19.0.0' } });
		try {
			assert.equal(resolveSourceRoot(root), path.join(root, '.flue'));
			assert.equal(findFlueProjectRoot(plain), undefined);
		} finally {
			cleanup(root);
			cleanup(plain);
		}
	});
});
