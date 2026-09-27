#!/usr/bin/env node
// Print a map of a Flue project: target, versions, source root and entry
// modules, every agent the 'use agent' scan registers (with its identity,
// mount, and Cloudflare Durable Object names), channels, wrangler migration
// status, and the edit-time lint findings for every relevant file.
//
// Uses the project's own @flue/vite scanner when installed (exact parity with
// `vite build`), else the heuristic scan. Read-only.
//
// usage: flue-inspect.mjs [dir] [--json] [--no-lint]

import path from 'node:path';
import { parseArgs } from 'node:util';
import {
	LEGACY_MARKERS,
	TESTED_FLUE_VERSION,
	agentBindingName,
	agentClassName,
	detectTarget,
	discoverEntry,
	findFlueProjectRoot,
	findNestedFlueProjects,
	findWranglerConfig,
	flueVersions,
	listModuleFiles,
	loadProjectScanner,
	majorOf,
	migratedClasses,
	packageManager,
	parseJsonc,
	readAppMounts,
	readText,
	resolveSourceRoot,
	scanAgentsHeuristic,
} from './lib/flue-project.mjs';
import { lintFile } from './lib/lint.mjs';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		json: { type: 'boolean' },
		'no-lint': { type: 'boolean' },
		help: { type: 'boolean', short: 'h' },
	},
});
if (values.help) {
	console.log('usage: flue-inspect.mjs [dir] [--json] [--no-lint]');
	process.exit(0);
}

const start = path.resolve(positionals[0] ?? process.cwd());
const direct = findFlueProjectRoot(start);
const roots = direct ? [direct] : findNestedFlueProjects(start);
if (roots.length === 0) {
	const message = `No Flue project found at or below ${start} (looked for a package.json depending on @flue/* or a flue.config.*).`;
	if (values.json) console.log(JSON.stringify({ projects: [], message }));
	else console.log(message);
	process.exit(1);
}

const reports = [];
for (const root of roots) reports.push(await inspect(root));
if (values.json) console.log(JSON.stringify({ projects: reports }, null, 2));
else console.log(reports.map(render).join('\n\n---\n\n'));

async function inspect(root) {
	const rel = (p) => (p ? path.relative(root, p).split(path.sep).join('/') || '.' : undefined);
	const sourceRoot = resolveSourceRoot(root);
	const { target, explicit, configFile, viteConfig } = detectTarget(root);
	const entries = { app: discoverEntry(sourceRoot, 'app'), db: discoverEntry(sourceRoot, 'db'), cloudflare: discoverEntry(sourceRoot, 'cloudflare') };
	const versions = flueVersions(root);
	const runtime = versions['@flue/runtime'];

	const scanner = await loadProjectScanner(root);
	const agents = [];
	const scanErrors = [];
	if (scanner) {
		for (const file of listModuleFiles(sourceRoot)) {
			const code = readText(file);
			if (!code?.includes('use agent')) continue;
			try {
				const scan = await scanner(code, file);
				if (!scan.hasDirective) continue;
				if (scan.agents.length === 0) scanErrors.push({ file: rel(file), message: "declares 'use agent' but exports no agents" });
				for (const agent of scan.agents) agents.push({ file, ...agent });
			} catch (err) {
				scanErrors.push({ file: rel(file), message: (err instanceof Error ? err.message : String(err)).replace(/^\[flue\]\s*/, '') });
			}
		}
	} else {
		agents.push(...scanAgentsHeuristic(sourceRoot));
	}

	const mounts = readAppMounts(entries.app);
	const sources = listModuleFiles(sourceRoot).map((file) => readText(file) ?? '').join('\n');
	const agentRows = agents.map((agent) => {
		const local = agent.exportName === 'default' ? agent.functionName : agent.exportName;
		const mount = mounts.agents.find((m) => m.agent === local)?.path;
		const dispatched = new RegExp(`(?:dispatch|init|getAgentInstance)\\(\\s*${local.replace(/\$/g, '\\$')}(?![\\w$])`).test(sources);
		return {
			identity: agent.identity,
			export: local,
			file: rel(agent.file),
			mount: mount ?? null,
			dispatched,
			...(target === 'cloudflare' ? { durableObjectClass: agentClassName(agent.identity), binding: agentBindingName(agent.identity) } : {}),
		};
	});

	let wrangler;
	const wranglerFile = findWranglerConfig(root);
	if (target === 'cloudflare' && wranglerFile && !wranglerFile.endsWith('.toml')) {
		try {
			const config = parseJsonc(readText(wranglerFile) ?? '');
			const { live, legacyKv, tags } = migratedClasses(config);
			const classes = new Set(agentRows.map((row) => row.durableObjectClass));
			wrangler = {
				file: rel(wranglerFile),
				name: config.name,
				compatibilityDate: config.compatibility_date,
				migrationTags: tags,
				missingMigrations: [...classes].filter((name) => !live.has(name)),
				staleFlueClasses: [...live].filter((name) => /^Flue.+Agent$/.test(name) && !classes.has(name)),
				legacyKvClasses: [...legacyKv],
			};
		} catch (err) {
			wrangler = { file: rel(wranglerFile), error: err instanceof Error ? err.message : String(err) };
		}
	}

	const legacy = new Set();
	for (const file of listModuleFiles(sourceRoot, { limit: 400 })) {
		const code = readText(file);
		if (!code || !/@flue\//.test(code)) continue;
		for (const marker of LEGACY_MARKERS) if (marker.pattern.test(code)) legacy.add(marker.label);
	}

	const findings = [];
	if (!values['no-lint']) {
		const files = new Set([...agents.map((a) => a.file), configFile, viteConfig, wranglerFile].filter(Boolean));
		for (const file of listModuleFiles(sourceRoot)) {
			if (readText(file)?.includes('use agent')) files.add(file);
		}
		for (const file of files) {
			const { findings: fileFindings } = await lintFile(root, file);
			for (const finding of fileFindings) findings.push({ file: rel(file), ...finding });
		}
	}

	return {
		root,
		sourceRoot: rel(sourceRoot),
		target,
		targetSource: explicit ? 'flue.config' : viteConfig ? 'vite plugins' : 'default',
		httpServer: Boolean(viteConfig),
		entries: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, rel(v) ?? null])),
		config: rel(configFile) ?? null,
		viteConfig: rel(viteConfig) ?? null,
		packageManager: packageManager(root),
		versions,
		testedAgainst: TESTED_FLUE_VERSION,
		preV2: (majorOf(runtime?.installed ?? runtime?.declared) ?? 2) < 2 || (!runtime && legacy.size > 0),
		legacyApis: [...legacy],
		scanner: scanner ? '@flue/vite' : 'heuristic',
		agents: agentRows,
		scanErrors,
		channels: mounts.channels,
		mountsViaGlob: mounts.usesGlob,
		wrangler,
		findings,
	};
}

function render(report) {
	const lines = [`# Flue project: ${report.root}`, ''];
	lines.push(`- Target: **${report.target}** (${report.targetSource})${report.httpServer ? '' : ' — no vite.config: `flue run` only'}`);
	lines.push(`- Source root: \`${report.sourceRoot}/\` · entries: app=${report.entries.app ?? '—'}, db=${report.entries.db ?? '—'}, cloudflare=${report.entries.cloudflare ?? '—'}`);
	lines.push(`- Config: ${report.config ?? '—'} · Vite: ${report.viteConfig ?? '—'} · package manager: ${report.packageManager}`);
	const versions = Object.entries(report.versions).map(([name, v]) => `${name} ${v.installed ?? `${v.declared} (not installed)`}`);
	lines.push(`- Versions: ${versions.join(', ') || '—'} (flue-loom verified against ${report.testedAgainst})`);
	if (report.preV2) lines.push(`- ⚠ **Pre-2.0 project** — legacy APIs: ${report.legacyApis.join(', ') || 'see versions'}. See the flue-migration skill.`);
	lines.push('', `## Agents (${report.agents.length}, ${report.scanner} scan)`, '');
	if (report.agents.length === 0) lines.push('_None registered._');
	else {
		const cf = report.target === 'cloudflare';
		lines.push(`| Identity | Export | File | HTTP mount | Dispatched in code |${cf ? ' DO class |' : ''}`);
		lines.push(`|---|---|---|---|---|${cf ? '---|' : ''}`);
		for (const a of report.agents) {
			lines.push(`| ${a.identity} | ${a.export} | ${a.file} | ${a.mount ? `\`${a.mount}/:id\`` : report.mountsViaGlob ? '(glob)' : '—'} | ${a.dispatched ? 'yes' : '—'} |${cf ? ` ${a.durableObjectClass} |` : ''}`);
		}
	}
	for (const e of report.scanErrors) lines.push(`- ✗ scan error in ${e.file}: ${e.message}`);
	if (report.channels.length > 0) {
		lines.push('', '## Channels', '');
		for (const c of report.channels) lines.push(`- \`${c.channel}\` mounted at \`${c.path}\``);
	}
	if (report.wrangler) {
		const w = report.wrangler;
		lines.push('', `## Wrangler (${w.file})`, '');
		if (w.error) lines.push(`- ✗ could not parse: ${w.error}`);
		else {
			lines.push(`- name: ${w.name ?? '—'} · compatibility_date: ${w.compatibilityDate ?? '—'} · migration tags: ${w.migrationTags.join(', ') || '—'}`);
			if (w.missingMigrations.length > 0) lines.push(`- ⚠ missing migrations: ${w.missingMigrations.join(', ')}`);
			if (w.staleFlueClasses.length > 0) lines.push(`- ℹ migrated Flue classes with no scanned agent: ${w.staleFlueClasses.join(', ')}`);
			if (w.legacyKvClasses.length > 0) lines.push(`- ✗ legacy new_classes: ${w.legacyKvClasses.join(', ')}`);
		}
	}
	lines.push('', `## Lint (${report.findings.length} finding${report.findings.length === 1 ? '' : 's'})`, '');
	if (report.findings.length === 0) lines.push('_Clean._');
	const icon = { error: '✗', warn: '⚠', info: 'ℹ' };
	for (const f of report.findings) lines.push(`- ${icon[f.level]} ${f.file}: ${f.message}`);
	return lines.join('\n');
}
