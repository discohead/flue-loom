// Edit-time lint for Flue 2 projects. Pure functions over (projectRoot,
// filePath): every check returns findings; nothing here writes or blocks.
//
// Agent modules are checked with the project's own @flue/vite scanner when it
// is installed (exact parity with `vite build`), falling back to the
// heuristic scan in flue-project.mjs. Everything else — wrangler migrations,
// vite/flue config wiring, SKILL.md frontmatter — mirrors the validation the
// Flue 2 toolchain performs, so problems surface at edit time instead of at
// the next `vite dev`, `vite build`, or deploy.

import fs from 'node:fs';
import path from 'node:path';
import {
	AGENT_IDENTITY_PATTERN,
	LEGACY_MARKERS,
	agentBindingName,
	agentClassName,
	collectAgentsHeuristic,
	detectTarget,
	discoverEntry,
	findWranglerConfig,
	hasAgentDirective,
	listModuleFiles,
	loadProjectScanner,
	migratedClasses,
	parseJsonc,
	readAppMounts,
	readText,
	resolveSourceRoot,
	scanAgentsHeuristic,
} from './flue-project.mjs';

const MODULE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);
const FLUE_CONFIG_FIELDS = new Set(['target', 'app', 'db', 'cloudflare', 'agents', 'providers', 'tracing']);
const MIN_COMPATIBILITY_DATE = '2026-04-01';

const error = (message) => ({ level: 'error', message });
const warn = (message) => ({ level: 'warn', message });
const info = (message) => ({ level: 'info', message });

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInside(child, parent) {
	const rel = path.relative(parent, child);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function relative(root, file) {
	return path.relative(root, file).split(path.sep).join('/');
}

/** Lint one edited file. Returns { findings, scanner } — scanner names what checked agent modules. */
export async function lintFile(root, filePath) {
	const segments = relative(root, filePath).split('/');
	if (segments.some((segment) => segment === 'node_modules' || segment === 'dist' || segment === '.wrangler')) {
		return { findings: [], scanner: undefined };
	}
	const base = path.basename(filePath);
	if (base === 'SKILL.md') return { findings: lintSkill(root, filePath), scanner: undefined };
	if (base === 'wrangler.jsonc' || base === 'wrangler.json') {
		return { findings: lintWrangler(root, filePath), scanner: undefined };
	}
	if (/^vite\.config\.[cm]?[jt]s$/.test(base)) return { findings: lintViteConfig(filePath), scanner: undefined };
	if (/^flue\.config\.[cm]?[jt]s$/.test(base)) return { findings: lintFlueConfig(root, filePath), scanner: undefined };
	if (MODULE_EXTENSIONS.has(path.extname(base))) return lintModule(root, filePath);
	return { findings: [], scanner: undefined };
}

// ─── Agent modules ───────────────────────────────────────────────────────────

async function lintModule(root, filePath) {
	const code = readText(filePath);
	if (code === undefined) return { findings: [], scanner: undefined };
	const findings = [];
	const importsFlue = /from\s+['"]@flue\//.test(code);
	const heuristic = collectAgentsHeuristic(code);

	// The project's own scanner decides directive membership and agent exports
	// when it is installed; the heuristic tokenizer is only the fallback.
	const scanner = code.includes('use agent') ? await loadProjectScanner(root) : undefined;
	let directive = hasAgentDirective(code);
	let agents = heuristic.agents;
	let scannerName = 'heuristic';
	if (scanner) {
		scannerName = '@flue/vite scanner';
		try {
			const scan = await scanner(code, filePath);
			directive = scan.hasDirective;
			agents = scan.agents.map((agent) => ({
				...agent,
				async: heuristic.agents.find((h) => h.functionName === agent.functionName)?.async ?? false,
			}));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			findings.push(error(`\`vite dev\`/\`vite build\` will reject this module: ${message.replace(/^\[flue\]\s*/, '')}`));
			findings.push(...legacyFindings(code));
			return { findings, scanner: scannerName };
		}
	}

	if (!directive) {
		if (/^\s*['"]use agent['"]\s*;?\s*$/m.test(code)) {
			findings.push(
				error(
					"`'use agent'` is present but not in the directive prologue, so Flue silently does NOT register this module's agents. Make it the very first statement — above every import.",
				),
			);
		} else if (/\buseModel\s*\(/.test(code) && /^export\s+(?:default\s+)?(?:async\s+)?function\s+[A-Z]/m.test(code)) {
			findings.push(
				warn(
					"This module exports a capitalized function that calls useModel() but has no `'use agent'` directive, so it is not a registered agent (dispatch()/createAgentRouter() will reject it). Add `'use agent';` as the first line — unless it is deliberately a subagent or helper module.",
				),
			);
		}
		if (importsFlue) findings.push(...legacyFindings(code));
		return { findings, scanner: scanner ? scannerName : undefined };
	}

	if (!scanner) {
		if (heuristic.problems.includes('anonymous-default')) {
			findings.push(
				error(
					"A 'use agent' module default-exports an anonymous function. An agent's identity is its function name — write `export default function MyAgent() { … }` or use a named export.",
				),
			);
		}
		for (const problem of heuristic.problems.filter((p) => p.startsWith('non-literal-agentName:'))) {
			const name = problem.split(':')[1];
			findings.push(
				error(`\`${name}.agentName\` must be a string literal assigned at the top level (\`${name}.agentName = 'my-agent'\`); build targets derive durable names from it before any code runs.`),
			);
		}
	}

	if (agents.length === 0) {
		if (!scanner && heuristic.problems.includes('anonymous-default')) return { findings, scanner: scannerName };
		findings.push(
			error(
				"This module declares `'use agent'` but exports no agents (no exported function with a capitalized name). The build fails on it — export one (`export function MyAgent() { … }`) or remove the directive.",
			),
		);
		return { findings, scanner: scannerName };
	}

	for (const agent of agents) {
		if (!AGENT_IDENTITY_PATTERN.test(agent.identity)) {
			findings.push(
				error(
					`Agent identity "${agent.identity}" is invalid; identities must match ${AGENT_IDENTITY_PATTERN} (PascalCase like \`IssueTriage\`, or a kebab-case \`agentName\` like \`issue-triage\` — no underscores, no leading digit).`,
				),
			);
		}
		if (agent.async) {
			findings.push(
				error(
					`\`${agent.functionName}\` is async. Agent functions must be synchronous (the runtime throws "[flue] Agent functions must be synchronous."). Move async work into tools, useAgentStart(), or a sandbox factory's createSandbox().`,
				),
			);
		}
	}

	if (!/\buseModel\s*\(/.test(code)) {
		findings.push(
			warn(
				'No useModel() call in this module. Every agent render must call useModel(\'provider/model\') exactly once — fine if a custom hook imported from elsewhere calls it, otherwise the first message fails.',
			),
		);
	}

	findings.push(...legacyFindings(code));
	const hasErrors = findings.some((finding) => finding.level === 'error');
	findings.push(...crossProjectFindings(root, filePath, agents, { mountHints: !hasErrors }));
	return { findings, scanner: scannerName };
}

function legacyFindings(code) {
	return LEGACY_MARKERS.filter(({ pattern }) => pattern.test(code)).map(({ message }) =>
		warn(`Pre-2.0 API: ${message}. See the flue-migration skill or \`npx flue docs read guide/migration\`.`),
	);
}

function crossProjectFindings(root, filePath, agents, { mountHints }) {
	const findings = [];
	const sourceRoot = resolveSourceRoot(root);
	const others = scanAgentsHeuristic(sourceRoot).filter((other) => path.resolve(other.file) !== path.resolve(filePath));

	for (const agent of agents) {
		const duplicate = others.find((other) => other.identity === agent.identity);
		if (duplicate) {
			findings.push(
				error(
					`Duplicate agent identity "${agent.identity}" — also exported by ${relative(root, duplicate.file)}. Identities key durable storage and must be unique; rename one or pin distinct \`agentName\` statics.`,
				),
			);
			continue;
		}
		const collision = others.find(
			(other) =>
				agentClassName(other.identity) === agentClassName(agent.identity) ||
				agentBindingName(other.identity) === agentBindingName(agent.identity),
		);
		if (collision) {
			findings.push(
				error(
					`Agent identities "${agent.identity}" and "${collision.identity}" (${relative(root, collision.file)}) fold to the same generated Durable Object name (${agentClassName(agent.identity)} / ${agentBindingName(agent.identity)}). Rename one.`,
				),
			);
		}
	}

	const { target } = detectTarget(root);
	if (target === 'cloudflare') findings.push(...missingMigrationFindings(root, agents));

	const appFile = discoverEntry(sourceRoot, 'app');
	if (mountHints && appFile && !readAppMounts(appFile).usesGlob) {
		const mounted = new Set(readAppMounts(appFile).agents.map((mount) => mount.agent));
		const sources = listModuleFiles(sourceRoot)
			.filter((file) => path.resolve(file) !== path.resolve(filePath))
			.map((file) => readText(file) ?? '')
			.join('\n');
		for (const agent of agents) {
			const local = agent.exportName === 'default' ? agent.functionName : agent.exportName;
			if (mounted.has(local)) continue;
			const name = escapeRegExp(local);
			const referenced = new RegExp(`(?:dispatch|init|getAgentInstance)\\(\\s*${name}(?![\\w$])|agents\\s*:\\s*\\[[^\\]]*(?<![\\w$])${name}(?![\\w$])`).test(sources);
			if (!referenced) {
				findings.push(
					info(
						`\`${local}\` is registered but neither mounted in ${relative(root, appFile)} nor dispatched anywhere. That's fine for a \`flue run\`-only agent; to serve it over HTTP add \`app.route('/agents/<name>', createAgentRouter(${local}))\`.`,
					),
				);
			}
		}
	}
	return findings;
}

function missingMigrationFindings(root, agents) {
	const wranglerFile = findWranglerConfig(root);
	if (!wranglerFile) {
		return [warn('Cloudflare target but no wrangler.jsonc at the project root; every agent needs a Durable Object migration entry there.')];
	}
	if (wranglerFile.endsWith('.toml')) return [];
	let wrangler;
	try {
		wrangler = parseJsonc(readText(wranglerFile) ?? '');
	} catch {
		return [];
	}
	const { live, legacyKv, tags } = migratedClasses(wrangler);
	const findings = [];
	const missing = agents.map((agent) => agentClassName(agent.identity)).filter((name) => !live.has(name));
	if (missing.length > 0) {
		const nextTag = `v${tags.length + 1}`;
		findings.push(
			warn(
				`${relative(root, wranglerFile)} has no Durable Object migration for ${missing.join(', ')}; \`wrangler deploy\` will fail. Append (never rewrite deployed entries): { "tag": "${nextTag}", "new_sqlite_classes": [${missing.map((name) => `"${name}"`).join(', ')}] }. If you renamed an agent, use "renamed_classes" instead to keep its conversations.`,
			),
		);
	}
	for (const agent of agents) {
		const className = agentClassName(agent.identity);
		if (legacyKv.has(className)) {
			findings.push(error(`${className} is introduced with legacy \`new_classes\`; Flue agent classes require Durable Object SQLite (\`new_sqlite_classes\`).`));
		}
	}
	return findings;
}

// ─── wrangler.jsonc ──────────────────────────────────────────────────────────

function lintWrangler(root, filePath) {
	if (detectTarget(root).target !== 'cloudflare') return [];
	let wrangler;
	try {
		wrangler = parseJsonc(readText(filePath) ?? '');
	} catch (err) {
		return [error(`Could not parse ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`)];
	}
	const findings = [];
	const date = wrangler.compatibility_date;
	if (typeof date === 'string' && date < MIN_COMPATIBILITY_DATE) {
		findings.push(error(`compatibility_date "${date}" is older than ${MIN_COMPATIBILITY_DATE}, the minimum Flue validates at build.`));
	}
	for (const binding of wrangler.durable_objects?.bindings ?? []) {
		if (typeof binding?.name === 'string' && /^FLUE_[A-Z0-9_]+_AGENT$/.test(binding.name)) {
			findings.push(
				error(`Durable Object binding "${binding.name}" uses a Flue-reserved name. Flue generates FLUE_*_AGENT bindings itself; remove the hand-written entry (keep only the migration).`),
			);
		}
	}
	const tags = (wrangler.migrations ?? []).map((migration) => migration.tag);
	const duplicateTags = tags.filter((tag, index) => tag !== undefined && tags.indexOf(tag) !== index);
	if (duplicateTags.length > 0) findings.push(error(`Duplicate migration tag(s): ${[...new Set(duplicateTags)].join(', ')}. Every migration needs a unique tag.`));

	const agents = scanAgentsHeuristic(resolveSourceRoot(root));
	const { live, legacyKv } = migratedClasses(wrangler);
	const missing = [...new Set(agents.map((agent) => agentClassName(agent.identity)))].filter((name) => !live.has(name));
	if (missing.length > 0) {
		findings.push(
			warn(
				`Scanned agents without a live migration: ${missing.join(', ')}. Append a new tag with "new_sqlite_classes" for each (or "renamed_classes" if an agent was renamed).`,
			),
		);
	}
	for (const name of legacyKv) {
		if (/^Flue.+Agent$/.test(name)) findings.push(error(`${name} is introduced with legacy \`new_classes\`; generated Flue agent classes require \`new_sqlite_classes\`.`));
	}
	const agentClasses = new Set(agents.map((agent) => agentClassName(agent.identity)));
	const stale = [...live].filter((name) => /^Flue.+Agent$/.test(name) && !agentClasses.has(name));
	if (stale.length > 0 && agents.length > 0) {
		findings.push(
			info(
				`Migrations keep ${stale.join(', ')} alive but no scanned agent generates ${stale.length === 1 ? 'it' : 'them'}. If ${stale.length === 1 ? 'that agent was' : 'those agents were'} removed or renamed, append a "deleted_classes" or "renamed_classes" migration — otherwise wrangler rejects the deploy.`,
			),
		);
	}
	return findings;
}

// ─── vite.config.* / flue.config.* ───────────────────────────────────────────

function lintViteConfig(filePath) {
	const code = readText(filePath) ?? '';
	const findings = [];
	const flueCalls = [...code.matchAll(/\bflue\s*\(/g)];
	const cloudflareCall = code.search(/\bcloudflare\s*\(/);
	if (flueCalls.length === 0) {
		findings.push(warn('No flue() plugin in this Vite config; `vite dev`/`vite build` will not build a Flue application.'));
	} else if (flueCalls.length > 1) {
		findings.push(error('flue() appears more than once; adding it to the same Vite config twice is an error.'));
	}
	if (cloudflareCall !== -1) {
		if (flueCalls.length > 0 && cloudflareCall < flueCalls[0].index) {
			findings.push(error('cloudflare() is listed before flue(). flue() must come first — the Cloudflare plugin consumes the Worker entry flue() generates.'));
		}
		if (!/flueWorkerConfig\s*\(/.test(code)) {
			findings.push(
				error("cloudflare() must receive Flue's worker config: `cloudflare({ config: flueWorkerConfig() })` with `import { flue, flueWorkerConfig } from '@flue/vite'`. Without it the Worker has no Flue entry or agent Durable Object bindings."),
			);
		}
	}
	return findings;
}

function lintFlueConfig(root, filePath) {
	const code = readText(filePath) ?? '';
	const findings = [];
	if (/from\s+['"]@flue\/cli\/config['"]/.test(code)) {
		findings.push(error("`@flue/cli/config` no longer exists; `import { defineConfig } from '@flue/runtime/config'`."));
	}
	const start = code.search(/defineConfig\s*\(|export\s+default/);
	const keys = start === -1 ? [] : topLevelKeys(code, code.indexOf('{', start));
	for (const key of keys) {
		if (key === 'root' || key === 'output') {
			findings.push(error(`\`${key}\` was retired from flue.config (Vite owns it); strict validation rejects the file. Delete it.`));
		} else if (!FLUE_CONFIG_FIELDS.has(key)) {
			findings.push(warn(`Unknown flue.config field \`${key}\`; valid fields are ${[...FLUE_CONFIG_FIELDS].join(', ')}. \`vite dev\`/\`vite build\` reject unknown fields.`));
		}
	}
	const target = code.match(/\btarget\s*:\s*['"]([^'"]*)['"]/)?.[1];
	if (target !== undefined && target !== 'node' && target !== 'cloudflare') {
		findings.push(error(`Invalid target "${target}"; use 'node' or 'cloudflare'.`));
	}
	const providers = code.match(/\bproviders\s*:\s*\[([^\]]*)\]/)?.[1];
	if (providers && /['"]cloudflare['"]/.test(providers) && detectTarget(root).target === 'node') {
		findings.push(error("providers lists 'cloudflare' on the Node target; the Workers AI binding provider only exists on Workers."));
	}
	return findings;
}

/**
 * Property names at depth 1 of the object literal opening at `open` —
 * skipping strings, template literals, comments, and nested braces/brackets,
 * so `tracing: { enabled: true }` yields only `tracing`.
 */
function topLevelKeys(code, open) {
	const keys = [];
	if (open === -1) return keys;
	let depth = 0;
	for (let i = open; i < code.length; i += 1) {
		const c = code[i];
		if (c === "'" || c === '"' || c === '`') {
			for (i += 1; i < code.length && code[i] !== c; i += 1) if (code[i] === '\\') i += 1;
		} else if (code.startsWith('//', i)) {
			i = code.indexOf('\n', i);
			if (i === -1) break;
		} else if (code.startsWith('/*', i)) {
			i = code.indexOf('*/', i + 2);
			if (i === -1) break;
			i += 1;
		} else if (c === '{' || c === '[' || c === '(') {
			depth += 1;
		} else if (c === '}' || c === ']' || c === ')') {
			depth -= 1;
			if (depth === 0) break;
		} else if (depth === 1 && /[A-Za-z_$]/.test(c) && /[{,\s]/.test(code[i - 1] ?? '')) {
			const match = code.slice(i).match(/^([A-Za-z_$][\w$]*)\s*:/);
			if (match && /(?:^|[{,])\s*$/.test(code.slice(open, i))) keys.push(match[1]);
			if (match) i += match[1].length - 1;
		}
	}
	return [...new Set(keys)];
}

// ─── SKILL.md ────────────────────────────────────────────────────────────────

/** Minimal YAML frontmatter reader: top-level `key: value` plus `>`/`|` block scalars. */
export function readFrontmatter(text) {
	const match = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) return undefined;
	const fields = {};
	const lines = match[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (!line) continue;
		let value = line[2].trim();
		if (/^[>|][+-]?$/.test(value)) {
			const block = [];
			while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
				block.push(lines[i + 1].trim());
				i += 1;
			}
			value = block.join(value.startsWith('>') ? ' ' : '\n').trim();
		} else {
			value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
		}
		fields[line[1]] = value;
	}
	return fields;
}

function lintSkill(root, filePath) {
	const rel = relative(root, filePath);
	if (rel.split('/').some((segment) => segment === '.claude')) return []; // Claude Code's own skills, not Flue's
	const text = readText(filePath) ?? '';
	const dirName = path.basename(path.dirname(filePath));
	const workspace = rel.includes('.agents/skills/');
	const where = workspace
		? 'Workspace skills with invalid frontmatter are skipped at runtime with only a warning'
		: 'Imported skills are validated at build time, so `vite build` fails on this';
	const fields = readFrontmatter(text);
	if (!fields) return [error(`Missing YAML frontmatter (--- name/description ---). ${where}.`)];
	const findings = [];
	const { name, description, compatibility } = fields;
	if (!name) findings.push(error(`Frontmatter needs \`name\`. ${where}.`));
	else {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
			findings.push(error(`Skill name "${name}" must be lowercase letters, digits, and single hyphens (max 64 chars).`));
		}
		if (name !== dirName) findings.push(error(`Skill name "${name}" must match its directory name "${dirName}".`));
	}
	if (!description) findings.push(error(`Frontmatter needs a non-empty \`description\` (what the skill does and when to use it). ${where}.`));
	else if (description.length > 1024) findings.push(error(`description is ${description.length} characters; the Agent Skills spec allows 1024.`));
	if (compatibility && compatibility.length > 500) findings.push(error(`compatibility is ${compatibility.length} characters; max 500.`));

	if (!workspace) {
		let entries = [];
		try {
			entries = fs.readdirSync(path.dirname(filePath), { withFileTypes: true, recursive: true });
		} catch {}
		for (const entry of entries) {
			const full = path.join(entry.parentPath ?? entry.path ?? path.dirname(filePath), entry.name);
			if (entry.isSymbolicLink()) {
				findings.push(error(`${relative(root, full)} is a symlink; skill packaging refuses symbolic links.`));
			} else if (/^\.env(?:\..*)?$|\.pem$|\.key$|^id_(?:rsa|ed25519|ecdsa)/.test(entry.name)) {
				findings.push(error(`${relative(root, full)} looks like a secret; skill packaging refuses .env files and private keys.`));
			}
		}
	}
	return findings;
}

/** Render findings as the hook's additionalContext block. */
export function formatFindings(rel, findings, scanner) {
	const icon = { error: '✗', warn: '⚠', info: 'ℹ' };
	const lines = [`flue-loom lint · ${rel}${scanner ? ` (${scanner})` : ''}`];
	for (const finding of findings) lines.push(`  ${icon[finding.level]} [${finding.level}] ${finding.message}`);
	return lines.join('\n');
}

export { isInside };
