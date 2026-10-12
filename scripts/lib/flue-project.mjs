// Shared, dependency-free helpers for flue-loom hooks and scripts.
//
// Locates a Flue project from any path inside it and mirrors the resolution
// rules the Flue 2 toolchain uses: the source-root waterfall
// (`.flue/` → `src/` → root), target detection, the `'use agent'` directive
// prologue, agent identities, and the Durable Object names the Cloudflare
// target derives from them. Everything here is a best-effort *static* view;
// where exact parity matters, callers prefer the project's own installed
// scanner (see loadProjectScanner).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The Flue release this plugin's skills and templates were verified against. */
export const TESTED_FLUE_VERSION = '2.1.1';

/** Mirrors AGENT_IDENTITY_PATTERN from @flue/runtime. */
export const AGENT_IDENTITY_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;

export const AGENT_DIRECTIVE = 'use agent';

const MODULE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);
const ENTRY_EXTENSIONS = ['ts', 'mts', 'js', 'mjs'];
const CONFIG_BASENAMES = [
	'flue.config.ts',
	'flue.config.mts',
	'flue.config.mjs',
	'flue.config.js',
	'flue.config.cjs',
	'flue.config.cts',
];
// The scan never descends into these (dot-directories are skipped too).
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'output', '.wrangler']);
const FLUE_PACKAGES = ['@flue/runtime', '@flue/vite', '@flue/cli', '@flue/sdk'];

export function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

export function readText(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

function isDirectory(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function declaredDependencies(pkg) {
	return { ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies };
}

export function findConfigFile(root) {
	for (const name of CONFIG_BASENAMES) {
		const candidate = path.join(root, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

function looksLikeFlueProject(dir, pkg) {
	const deps = declaredDependencies(pkg);
	return FLUE_PACKAGES.some((name) => name in deps) || findConfigFile(dir) !== undefined;
}

/**
 * Walk up from `start` to the nearest directory whose package.json depends on
 * a Flue package (or that holds a flue.config.*). Returns undefined outside a
 * Flue project.
 */
export function findFlueProjectRoot(start) {
	let dir = path.resolve(start);
	if (!isDirectory(dir)) dir = path.dirname(dir);
	for (;;) {
		const pkg = readJson(path.join(dir, 'package.json'));
		if ((pkg && looksLikeFlueProject(dir, pkg)) || findConfigFile(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Find Flue projects *below* `dir` (monorepos: the session may start at a
 * repo root whose own package.json has no Flue dependency). Shallow and
 * bounded so it stays cheap enough for a SessionStart hook.
 */
export function findNestedFlueProjects(dir, { maxDepth = 3, limit = 5 } = {}) {
	const found = [];
	const visit = (current, depth) => {
		if (found.length >= limit || depth > maxDepth) return;
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			const child = path.join(current, entry.name);
			const pkg = readJson(path.join(child, 'package.json'));
			if (pkg && looksLikeFlueProject(child, pkg)) {
				found.push(child);
				if (found.length >= limit) return;
				continue;
			}
			visit(child, depth + 1);
		}
	};
	visit(path.resolve(dir), 1);
	return found;
}

/** The project's package manager, from the nearest lockfile (npm when none). */
export function packageManager(root) {
	let dir = root;
	for (;;) {
		if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
		if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
		if (fs.existsSync(path.join(dir, 'bun.lock')) || fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
		if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
		const parent = path.dirname(dir);
		if (parent === dir) return 'npm';
		dir = parent;
	}
}

/** Mirrors resolveSourceRoot from @flue/runtime/config. */
export function resolveSourceRoot(root) {
	for (const name of ['.flue', 'src']) {
		const candidate = path.join(root, name);
		if (isDirectory(candidate)) return candidate;
	}
	return root;
}

/** Mirrors discoverProjectEntry: `<sourceRoot>/<basename>.{ts,mts,js,mjs}`. */
export function discoverEntry(sourceRoot, basename) {
	for (const ext of ENTRY_EXTENSIONS) {
		const candidate = path.join(sourceRoot, `${basename}.${ext}`);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function findViteConfig(root) {
	for (const name of ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
		const candidate = path.join(root, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function findWranglerConfig(root) {
	for (const name of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
		const candidate = path.join(root, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Effective target, the way the flue() plugin decides it: an explicit
 * `target` in flue.config.*, else 'cloudflare' when vite.config.* uses
 * @cloudflare/vite-plugin, else 'node'. `deploy` is whether the HTTP server
 * setup (vite.config.* + app.ts) exists at all — a `flue init` project
 * without `--deploy` runs agents only through `flue run`.
 */
export function detectTarget(root) {
	const configFile = findConfigFile(root);
	const configText = configFile ? readText(configFile) : undefined;
	const explicit = configText?.match(/\btarget\s*:\s*['"](node|cloudflare)['"]/)?.[1];
	const viteConfig = findViteConfig(root);
	const viteText = viteConfig ? readText(viteConfig) : undefined;
	const usesCloudflarePlugin = viteText?.includes('@cloudflare/vite-plugin') ?? false;
	return {
		target: explicit ?? (usesCloudflarePlugin ? 'cloudflare' : 'node'),
		explicit: explicit !== undefined,
		configFile,
		viteConfig,
	};
}

/** Installed versions (from node_modules) and declared ranges of Flue packages. */
export function flueVersions(root) {
	const pkg = readJson(path.join(root, 'package.json')) ?? {};
	const declared = declaredDependencies(pkg);
	const versions = {};
	for (const name of FLUE_PACKAGES) {
		const installed = readJson(path.join(root, 'node_modules', ...name.split('/'), 'package.json'))?.version;
		if (installed || declared[name]) versions[name] = { installed, declared: declared[name] };
	}
	return versions;
}

/** Leading major version of a semver string or range (`^2.1.1` → 2); undefined when unknowable. */
export function majorOf(versionOrRange) {
	const match = typeof versionOrRange === 'string' ? versionOrRange.match(/(\d+)\.\d+/) : null;
	return match ? Number(match[1]) : undefined;
}

export function compareVersions(a, b) {
	const pa = a.split(/[.-]/).map((part) => (Number.isNaN(Number(part)) ? part : Number(part)));
	const pb = b.split(/[.-]/).map((part) => (Number.isNaN(Number(part)) ? part : Number(part)));
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x === y) continue;
		if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
		return String(x) < String(y) ? -1 : 1;
	}
	return 0;
}

// ─── Directive prologue ──────────────────────────────────────────────────────

function skipTrivia(code, index, { stopAtNewline = false } = {}) {
	let i = index;
	while (i < code.length) {
		const c = code[i];
		if (c === '\n' || c === '\r') {
			if (stopAtNewline) return i;
			i += 1;
		} else if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') {
			i += 1;
		} else if (code.startsWith('//', i)) {
			const end = code.indexOf('\n', i);
			i = end === -1 ? code.length : end;
		} else if (code.startsWith('/*', i)) {
			const end = code.indexOf('*/', i + 2);
			if (end === -1) return code.length;
			if (stopAtNewline && /[\r\n]/.test(code.slice(i, end))) return i;
			i = end + 2;
		} else {
			return i;
		}
	}
	return i;
}

/**
 * Whether `code`'s ECMAScript directive prologue contains `'use agent'` —
 * the same rule @flue/vite applies (raw text between the quotes must be
 * exactly `use agent`; the directive must come before any import or other
 * statement). A lightweight tokenizer, not a parser: good enough for lint
 * and discovery, and exact for every ordinary way of writing a module head.
 */
export function hasAgentDirective(code) {
	if (!code.includes(AGENT_DIRECTIVE)) return false;
	let i = 0;
	if (code.startsWith('#!')) {
		const end = code.indexOf('\n');
		i = end === -1 ? code.length : end + 1;
	}
	for (;;) {
		i = skipTrivia(code, i);
		const quote = code[i];
		if (quote !== "'" && quote !== '"') return false;
		let j = i + 1;
		while (j < code.length && code[j] !== quote) {
			if (code[j] === '\\') j += 1;
			else if (code[j] === '\n') return false;
			j += 1;
		}
		if (j >= code.length) return false;
		const raw = code.slice(i + 1, j);
		let k = skipTrivia(code, j + 1, { stopAtNewline: true });
		if (k < code.length && code[k] === ';') {
			k += 1;
		} else if (k < code.length && code[k] !== '\n' && code[k] !== '\r' && code[k] !== '}') {
			return false; // `'use agent'.length`, `'use agent' + x`, … — an expression, not a directive
		} else {
			// Automatic semicolon insertion: a following token that continues
			// the expression means this string was never a directive.
			const next = skipTrivia(code, k);
			if (next < code.length && /^(?:[.([`+\-*/%,?<>=&|^!]|in\b|instanceof\b)/.test(code.slice(next, next + 11))) {
				return false;
			}
		}
		if (raw === AGENT_DIRECTIVE) return true;
		i = k;
	}
}

// ─── Agent exports (heuristic) ───────────────────────────────────────────────

function isCapitalized(name) {
	return /^[A-Z]/.test(name);
}

/**
 * Collect a marked module's agents — exported capitalized functions — with a
 * regex view of the forms @flue/vite recognizes. Also reports the problems the
 * real scanner throws on (anonymous default export, non-literal agentName).
 * Prefer loadProjectScanner() when the project has @flue/vite installed.
 */
export function collectAgentsHeuristic(code) {
	const problems = [];
	const localFunctions = new Map(); // local name → { async }
	for (const match of code.matchAll(/^(?:export\s+(?:default\s+)?)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/gm)) {
		localFunctions.set(match[2], { async: Boolean(match[1]) });
	}
	for (const match of code.matchAll(
		/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/gm,
	)) {
		localFunctions.set(match[1], { async: Boolean(match[2]) });
	}

	const agents = [];
	const add = (exportName, functionName) => {
		if (agents.some((agent) => agent.exportName === exportName)) return;
		agents.push({ exportName, functionName, async: localFunctions.get(functionName)?.async ?? false });
	};

	for (const match of code.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
		if (isCapitalized(match[1])) add(match[1], match[1]);
	}
	for (const match of code.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
		if (isCapitalized(match[1]) && localFunctions.has(match[1])) add(match[1], match[1]);
	}
	for (const match of code.matchAll(/^export\s+default\s+(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/gm)) {
		if (!match[2]) problems.push('anonymous-default');
		else if (isCapitalized(match[2])) add('default', match[2]);
	}
	if (/^export\s+default\s+(?:async\s*)?\([^)]*\)\s*=>/m.test(code)) problems.push('anonymous-default');
	for (const match of code.matchAll(/^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) {
		if (isCapitalized(match[1]) && localFunctions.has(match[1])) add('default', match[1]);
	}
	for (const match of code.matchAll(/^export\s*\{([^}]*)\}\s*(from\b)?/gm)) {
		if (match[2]) continue; // re-exports never register
		for (const specifier of match[1].split(',')) {
			const [local, exported = local] = specifier
				.trim()
				.replace(/^type\s+/, '')
				.split(/\s+as\s+/)
				.map((s) => s.trim());
			if (!local || !localFunctions.has(local)) continue;
			if (exported === 'default') {
				if (isCapitalized(local)) add('default', local);
			} else if (isCapitalized(exported)) {
				add(exported, local);
			}
		}
	}

	const overrides = new Map();
	for (const match of code.matchAll(/^([A-Za-z_$][\w$]*)\.agentName\s*=\s*(.+)$/gm)) {
		const rhs = match[2].replace(/\/\/.*$/, '').trim().replace(/;$/, '').trim();
		const literal = rhs.match(/^(['"])([^'"]*)\1$/);
		if (literal) overrides.set(match[1], literal[2]);
		else if (agents.some((agent) => agent.functionName === match[1])) problems.push(`non-literal-agentName:${match[1]}`);
	}

	return {
		agents: agents.map((agent) => ({
			...agent,
			identity:
				overrides.get(agent.functionName) ?? (agent.exportName === 'default' ? agent.functionName : agent.exportName),
		})),
		problems,
	};
}

/**
 * Load `scanAgentModuleCode` from the project's own @flue/vite (its
 * `/internal` entry — unstable by contract, so every failure falls back to
 * undefined and callers use the heuristic scan instead).
 */
export async function loadProjectScanner(root) {
	if (process.env.FLUE_LOOM_NO_PROJECT_SCANNER) return undefined;
	try {
		const packageDir = fs.realpathSync(path.join(root, 'node_modules', '@flue', 'vite'));
		const pkg = readJson(path.join(packageDir, 'package.json'));
		const target = pkg?.exports?.['./internal'];
		const entry = typeof target === 'string' ? target : (target?.import ?? target?.default);
		if (typeof entry !== 'string') return undefined;
		const mod = await import(pathToFileURL(path.join(packageDir, entry)).href);
		return typeof mod.scanAgentModuleCode === 'function' ? mod.scanAgentModuleCode : undefined;
	} catch {
		return undefined;
	}
}

// ─── Project-wide views ──────────────────────────────────────────────────────

/** Every `.ts/.mts/.js/.mjs` file under `sourceRoot`, with the scan's exclusions. */
export function listModuleFiles(sourceRoot, { limit = 4000 } = {}) {
	const files = [];
	const visit = (dir) => {
		if (files.length >= limit) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(full);
			} else if (MODULE_EXTENSIONS.has(path.extname(entry.name))) {
				files.push(full);
				if (files.length >= limit) return;
			}
		}
	};
	visit(sourceRoot);
	return files;
}

/** Heuristic 'use agent' scan of a source root: [{ file, identity, exportName, functionName }]. */
export function scanAgentsHeuristic(sourceRoot) {
	const results = [];
	for (const file of listModuleFiles(sourceRoot)) {
		const code = readText(file);
		if (!code || !hasAgentDirective(code)) continue;
		for (const agent of collectAgentsHeuristic(code).agents) results.push({ file, ...agent });
	}
	return results;
}

/**
 * Agent and channel mounts in app.ts:
 *   app.route('/agents/x', createAgentRouter(X))
 *   app.route('/channels/slack', channel.route())
 */
export function readAppMounts(appFile) {
	const code = appFile ? readText(appFile) : undefined;
	if (!code) return { agents: [], channels: [], usesGlob: false };
	const agents = [];
	for (const match of code.matchAll(/\.route\(\s*(['"`])([^'"`]+)\1\s*,\s*createAgentRouter\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
		agents.push({ path: match[2], agent: match[3] });
	}
	const channels = [];
	for (const match of code.matchAll(/\.route\(\s*(['"`])([^'"`]+)\1\s*,\s*([A-Za-z_$][\w$]*)\.route\(\s*\)/g)) {
		channels.push({ path: match[2], channel: match[3] });
	}
	return { agents, channels, usesGlob: /import\.meta\.glob/.test(code) };
}

/** `Flue<PascalCase>Agent`, exactly as @flue/vite derives it. */
export function agentClassName(identity) {
	return `Flue${identity
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('')}Agent`;
}

/** `FLUE_<SNAKE_UPPER>_AGENT`, exactly as @flue/vite derives it. */
export function agentBindingName(identity) {
	return `FLUE_${identity
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/-/g, '_')
		.toUpperCase()}_AGENT`;
}

/** Parse JSON with comments and trailing commas (wrangler.jsonc). */
export function parseJsonc(text) {
	let out = '';
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i];
		if (inString) {
			out += c;
			if (c === '\\') {
				out += text[i + 1] ?? '';
				i += 1;
			} else if (c === '"') {
				inString = false;
			}
		} else if (c === '"') {
			inString = true;
			out += c;
		} else if (text.startsWith('//', i)) {
			const end = text.indexOf('\n', i);
			i = end === -1 ? text.length : end - 1;
		} else if (text.startsWith('/*', i)) {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 1;
		} else {
			out += c;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Durable Object classes the wrangler migration history currently provides:
 * new_sqlite_classes and renamed_classes[].to, minus deleted_classes and
 * renamed_classes[].from. Also reports classes introduced as legacy KV
 * `new_classes`, which Flue's generated classes must never use.
 */
export function migratedClasses(wrangler) {
	const live = new Set();
	const legacyKv = new Set();
	for (const migration of Array.isArray(wrangler?.migrations) ? wrangler.migrations : []) {
		for (const name of migration.new_sqlite_classes ?? []) live.add(name);
		for (const name of migration.new_classes ?? []) {
			live.add(name);
			legacyKv.add(name);
		}
		for (const rename of migration.renamed_classes ?? []) {
			live.delete(rename.from);
			live.add(rename.to);
		}
		for (const name of migration.deleted_classes ?? []) live.delete(name);
	}
	const tags = (Array.isArray(wrangler?.migrations) ? wrangler.migrations : []).map((m) => m.tag).filter(Boolean);
	return { live, legacyKv, tags };
}

/** Markers of pre-2.0 Flue code (0.x handlers and 1.0-beta defineAgent). */
export const LEGACY_MARKERS = [
	{ label: '`export const triggers`', pattern: /export\s+const\s+triggers\s*=/, message: '`export const triggers` is a Flue 0.x export; Flue 2 has no triggers — mount the agent in app.ts for HTTP and dispatch() from a cron for schedules' },
	{ label: '`FlueContext` handlers', pattern: /\bFlueContext\b/, message: '`FlueContext` handlers are Flue 0.x; a Flue 2 agent is an exported capitalized function in a \'use agent\' module' },
	{ label: '`@flue/sdk/client` imports', pattern: /from\s+['"]@flue\/sdk\/client['"]/, message: '`@flue/sdk/client` no longer exists; agents import from `@flue/runtime` (and `@flue/sdk` is now the HTTP client)' },
	{ label: '`defineAgent()`', pattern: /\bdefineAgent\s*\(/, message: '`defineAgent()` was removed in Flue 2; the agent is the function — compose it with hooks' },
	{ label: '`defineWorkflow()`', pattern: /\bdefineWorkflow\s*\(/, message: '`defineWorkflow()` was removed in Flue 2; use a (durable) tool, an init() handle, or your platform\'s workflow engine' },
	{ label: '`defineAgentProfile()`', pattern: /\bdefineAgentProfile\s*\(/, message: '`defineAgentProfile()` was removed; declare delegates with useSubagent()/defineSubagent()' },
	{ label: '`connectMcpServer()`', pattern: /\bconnectMcpServer\s*\(/, message: '`connectMcpServer()` is Flue 0.x; use useMcpConnection() (or createMcpConnection() on Node)' },
	{ label: '`session.prompt/skill/task/shell`', pattern: /\bsession\.(?:prompt|skill|task|shell)\s*\(/, message: '`session.prompt/skill/task/shell` is the pre-2.0 session API; model work inside tools is `harness.prompt()` (harness: true), delegation is useSubagent() + the task tool' },
	{ label: 'tool `parameters: Type.*`', pattern: /\bparameters\s*:\s*Type\./, message: 'Tool `parameters: Type.Object(...)` is Flue 0.x; Flue 2 tools declare `input` as a Valibot object schema and implement `run`' },
	{ label: 'tool `execute`', pattern: /\bexecute\s*:\s*(?:async\s*)?\(/, message: 'Tool `execute` is Flue 0.x; Flue 2 tools implement `run({ data })` and return `{ output }` (or a string)' },
	{ label: 'tool `run({ input })`', pattern: /\brun\s*(?::\s*(?:async\s*)?function\s*)?\(?\s*(?:async\s*)?\(\s*\{\s*input\b/, message: 'Tool `run({ input })` is 1.0-beta; the parsed arguments are `data` in Flue 2: `run({ data })`' },
	{ label: 'import attributes', pattern: /with\s*\{\s*type\s*:\s*['"](?:skill|markdown|md)['"]\s*\}/, message: 'Import attributes (`with { type: \'skill\' }`) were removed; import `.../SKILL.md` directly, or wrap other markdown with defineSkill()' },
	{ label: '`@flue/cli/config`', pattern: /from\s+['"]@flue\/cli\/config['"]/, message: '`@flue/cli/config` is gone; import defineConfig from `@flue/runtime/config`' },
];
