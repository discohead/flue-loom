#!/usr/bin/env node
// SessionStart hook for flue-loom.
//
// When the session starts inside (or above) a Flue project, hand Claude a
// compact map of it: target, source root, installed versions, the agents the
// 'use agent' scan would register and where app.ts mounts them. Flags
// pre-2.0 projects (Flue 2 is a ground-up redesign) and version drift from
// the release this plugin was verified against. Silent everywhere else.
//
// Heuristic-only on purpose: it must stay fast, so it never imports the
// project's toolchain. Reads { cwd, source } on stdin; falls back to $PWD.

import fs from 'node:fs';
import path from 'node:path';
import {
	LEGACY_MARKERS,
	TESTED_FLUE_VERSION,
	agentClassName,
	compareVersions,
	detectTarget,
	discoverEntry,
	findFlueProjectRoot,
	findNestedFlueProjects,
	findWranglerConfig,
	flueVersions,
	hasAgentDirective,
	listModuleFiles,
	majorOf,
	migratedClasses,
	packageManager,
	parseJsonc,
	readAppMounts,
	readText,
	resolveSourceRoot,
	scanAgentsHeuristic,
} from './lib/flue-project.mjs';

let input = '';
if (!process.stdin.isTTY) {
	process.stdin.setEncoding('utf8');
	for await (const chunk of process.stdin) input += chunk;
}
let payload = {};
try {
	payload = JSON.parse(input || '{}');
} catch {
	// Tolerate being run by hand or a payload-shape change; fall back to $PWD.
}
const cwd = typeof payload.cwd === 'string' && fs.existsSync(payload.cwd) ? payload.cwd : process.cwd();

const direct = findFlueProjectRoot(cwd);
const roots = direct ? [direct] : findNestedFlueProjects(cwd);
if (roots.length === 0) process.exit(0);

const sections = roots.slice(0, 3).map((root) => describeProject(root, cwd));
if (roots.length > 3) sections.push(`(+${roots.length - 3} more Flue projects below ${cwd})`);

console.log(
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'SessionStart',
			additionalContext: sections.join('\n\n'),
		},
	}),
);

function describeProject(root, from) {
	const rel = (p) => path.relative(from, p).split(path.sep).join('/') || '.';
	const versions = flueVersions(root);
	const runtime = versions['@flue/runtime'];
	const runtimeMajor = majorOf(runtime?.installed ?? runtime?.declared);
	const legacySdk = versions['@flue/sdk'] && !runtime && (majorOf(versions['@flue/sdk'].installed ?? versions['@flue/sdk'].declared) ?? 2) < 2;
	const sourceRoot = resolveSourceRoot(root);
	const legacyHits = legacyMarkers(sourceRoot);
	const isLegacy = (runtimeMajor !== undefined && runtimeMajor < 2) || legacySdk || (runtimeMajor === undefined && legacyHits.length > 0);

	const lines = [];
	const where = rel(root);
	if (isLegacy) {
		const which = runtime
			? `@flue/runtime ${runtime.installed ?? runtime.declared}`
			: `@flue/sdk ${versions['@flue/sdk']?.installed ?? versions['@flue/sdk']?.declared ?? '(unknown)'}`;
		lines.push(`[flue-loom] Pre-2.0 Flue project at ${where} (${which}).`);
		lines.push(
			'Flue 2 is a ground-up redesign: agents are exported capitalized functions in `\'use agent\'` modules composed with hooks (useModel, useTool, …); `vite dev`/`vite build` replace `flue dev`/`flue build`; app.ts mounts agents explicitly; triggers, defineAgent, workflows, and the FlueContext handler API are gone.',
		);
		if (legacyHits.length > 0) lines.push(`Legacy APIs in use: ${legacyHits.slice(0, 4).join('; ')}.`);
		lines.push('Offer /flue-loom:migrate (the flue-migration skill has the full mapping). Do not write new code against the old API.');
		return lines.join('\n');
	}

	const { target, viteConfig } = detectTarget(root);
	const appFile = discoverEntry(sourceRoot, 'app');
	const dbFile = discoverEntry(sourceRoot, 'db');
	const pm = packageManager(root);
	const exec = { pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx', npm: 'npx' }[pm];

	const installed = Object.entries(versions)
		.map(([name, v]) => `${name} ${v.installed ?? `${v.declared} (not installed)`}`)
		.join(', ');
	lines.push(
		`[flue-loom] Flue project at ${where} — target ${target}${viteConfig ? '' : ' (no vite.config: `flue run` only, no HTTP server)'}, source root ${rel(sourceRoot)}/, package manager ${pm}.`,
	);
	if (installed) lines.push(`Packages: ${installed}. flue-loom was verified against Flue ${TESTED_FLUE_VERSION}.`);

	const agents = scanAgentsHeuristic(sourceRoot);
	const mounts = readAppMounts(appFile);
	const mountOf = new Map(mounts.agents.map((mount) => [mount.agent, mount.path]));
	if (agents.length > 0) {
		const shown = agents.slice(0, 12).map((agent) => {
			const local = agent.exportName === 'default' ? agent.functionName : agent.exportName;
			const mount = mountOf.get(local);
			const identity = agent.identity === local ? '' : ` [identity ${agent.identity}]`;
			const reach = mount ? `→ ${mount}/:id` : mounts.usesGlob ? '(mounted via import.meta.glob?)' : viteConfig ? '(not mounted: dispatch/flue run only)' : '';
			return `${local}${identity} ${reach} (${rel(agent.file)})`.replace(/\s+/g, ' ').trim();
		});
		lines.push(`Agents (${agents.length}): ${shown.join(' · ')}${agents.length > 12 ? ' · …' : ''}`);
	} else {
		lines.push(`No registered 'use agent' modules found under ${rel(sourceRoot)}/.`);
	}
	const misplaced = misplacedDirectives(sourceRoot);
	if (misplaced.length > 0) {
		lines.push(
			`⚠ Not registered — \`'use agent'\` is below other statements in ${misplaced.slice(0, 5).map(rel).join(', ')}${misplaced.length > 5 ? ', …' : ''}. It must be the first statement (above every import); otherwise Flue silently skips the module.`,
		);
	}
	if (!mounts.usesGlob) {
		const registered = new Set(agents.flatMap((agent) => [agent.exportName, agent.functionName]));
		const unknown = mounts.agents.filter((mount) => !registered.has(mount.agent));
		if (unknown.length > 0) {
			lines.push(`⚠ ${rel(appFile)} mounts ${unknown.map((m) => `${m.agent} (${m.path})`).join(', ')}, which no 'use agent' module exports as an agent — \`vite dev\` will reject it.`);
		}
	}
	if (mounts.channels.length > 0) {
		lines.push(`Channels: ${mounts.channels.map((c) => `${c.channel} → ${c.path}`).join(' · ')}`);
	}
	if (viteConfig && !appFile) lines.push(`⚠ vite.config exists but ${rel(sourceRoot)}/app.ts is missing — \`vite dev\`/\`vite build\` require it.`);
	if (target === 'node' && viteConfig) {
		lines.push(dbFile ? `Persistence: ${rel(dbFile)}.` : 'Persistence: none (no db.ts) — conversations are in-memory and lost on restart.');
	}
	if (target === 'cloudflare') lines.push(...cloudflareNotes(root, agents, rel));

	if (!fs.existsSync(path.join(root, 'node_modules'))) {
		lines.push(`⚠ Dependencies are not installed — run \`${pm} install\` before \`flue run\`/\`vite dev\`.`);
	}
	const runtimeVersion = runtime?.installed;
	if (runtimeVersion && compareVersions(runtimeVersion, TESTED_FLUE_VERSION) > 0 && runtimeVersion.split('.')[1] !== TESTED_FLUE_VERSION.split('.')[1]) {
		lines.push(`Installed @flue/runtime ${runtimeVersion} is newer than the ${TESTED_FLUE_VERSION} flue-loom was verified against — where a skill and the installed docs disagree, trust the docs.`);
	}
	lines.push(
		`Version-matched docs: \`${exec} flue docs search <query>\` then \`${exec} flue docs read <path>\` (or Read/Grep node_modules/@flue/cli/docs/). Blueprints: \`${exec} flue add\`.`,
	);
	return lines.join('\n');
}

function cloudflareNotes(root, agents, rel) {
	const wranglerFile = findWranglerConfig(root);
	if (!wranglerFile) return ['⚠ Cloudflare target without wrangler.jsonc — every agent needs a Durable Object migration there.'];
	if (wranglerFile.endsWith('.toml')) return [];
	try {
		const { live } = migratedClasses(parseJsonc(readText(wranglerFile) ?? ''));
		const missing = [...new Set(agents.map((agent) => agentClassName(agent.identity)))].filter((name) => !live.has(name));
		return missing.length > 0
			? [`⚠ ${rel(wranglerFile)} has no migration for ${missing.join(', ')} — append a new tag with "new_sqlite_classes" before deploying.`]
			: [];
	} catch {
		return [`⚠ Could not parse ${rel(wranglerFile)}.`];
	}
}

/** Modules with a standalone `'use agent'` line that isn't in the directive prologue. */
function misplacedDirectives(sourceRoot) {
	const files = [];
	for (const file of listModuleFiles(sourceRoot, { limit: 400 })) {
		const code = readText(file);
		if (code && /^\s*['"]use agent['"]\s*;?\s*$/m.test(code) && !hasAgentDirective(code)) files.push(file);
	}
	return files;
}

function legacyMarkers(sourceRoot) {
	const hits = new Set();
	for (const file of listModuleFiles(sourceRoot, { limit: 400 })) {
		const code = readText(file);
		if (!code || !/@flue\//.test(code)) continue;
		for (const marker of LEGACY_MARKERS) {
			if (marker.pattern.test(code)) hits.add(marker.label);
		}
		if (hits.size >= 6) break;
	}
	return [...hits];
}
