#!/usr/bin/env node
// List or validate Flue model specifiers ('provider/model-id') against the
// model catalog of the Pi version the project actually has installed — the
// same catalog useModel() resolves against. An unknown specifier fails a
// Flue agent at runtime, so check before you write one.
//
// usage: flue-models.mjs [filter] [--check <specifier>] [--details] [--json] [--project <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findFlueProjectRoot } from './lib/flue-project.mjs';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		check: { type: 'string' },
		details: { type: 'boolean' },
		json: { type: 'boolean' },
		project: { type: 'string' },
		help: { type: 'boolean', short: 'h' },
	},
});

if (values.help) {
	console.log(`usage: flue-models.mjs [filter] [--check <provider/model>] [--details] [--json] [--project <dir>]

  filter          substring match, e.g. "anthropic/" or "sonnet"
  --check <spec>  exit 0 if the specifier exists in the installed catalog, else 1 (with suggestions)
  --details       include context window, output limit, reasoning, and input modalities
  --json          machine-readable output`);
	process.exit(0);
}

const root = findFlueProjectRoot(values.project ?? process.cwd());
const catalog = (root && (await loadInstalledCatalog(root))) ?? (await loadPublishedCatalog());

const filter = positionals[0]?.toLowerCase();
const entries = catalog.models.filter((model) => !filter || model.specifier.toLowerCase().includes(filter));

if (values.check) {
	const hit = catalog.models.find((model) => model.specifier === values.check);
	if (hit) {
		console.log(values.json ? JSON.stringify({ ok: true, source: catalog.source, model: hit }) : `ok — ${hit.specifier} (${catalog.source})`);
		process.exit(0);
	}
	const [provider, ...rest] = values.check.split('/');
	const id = rest.join('/');
	const stem = id.split(/[-.]/).slice(0, 2).join('-');
	const nearProvider = (name) => name === provider || editDistance(name, provider) <= 2;
	const suggestions = catalog.models
		.map((model) => ({
			model,
			score:
				(nearProvider(model.provider) ? 100 : 0) +
				(model.id === id ? 60 : 0) +
				(stem && model.id.includes(stem) ? 25 : 0),
		}))
		.filter(({ score }) => score >= 25 && score !== 100)
		.sort((a, b) => b.score - a.score || a.model.specifier.localeCompare(b.model.specifier))
		.map(({ model }) => model.specifier)
		.slice(0, 8);
	if (suggestions.length === 0) {
		suggestions.push(
			...catalog.models
				.filter((model) => nearProvider(model.provider))
				.map((model) => model.specifier)
				.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
				.slice(0, 8),
		);
	}
	if (values.json) {
		console.log(JSON.stringify({ ok: false, source: catalog.source, suggestions }));
	} else {
		console.error(`✗ ${values.check} is not in the ${catalog.source} catalog.`);
		if (!catalog.providers.includes(provider)) console.error(`  Unknown provider "${provider}". Providers: ${catalog.providers.join(', ')}`);
		if (suggestions.length > 0) console.error(`  Did you mean: ${suggestions.join(', ')}`);
		console.error('  Custom or local models need a provider registered with setProvider() — see the flue-models skill.');
	}
	process.exit(1);
}

if (values.json) {
	console.log(JSON.stringify({ source: catalog.source, models: entries }, null, 2));
} else {
	console.log(`# ${entries.length} model specifiers — ${catalog.source}`);
	for (const model of entries) {
		if (!values.details || model.contextWindow === undefined) {
			console.log(model.specifier);
			continue;
		}
		const flags = [model.reasoning ? 'reasoning' : '', (model.input ?? []).includes('image') ? 'image' : ''].filter(Boolean).join(' ');
		console.log(`${model.specifier}\tctx=${model.contextWindow} out=${model.maxTokens}${flags ? ` ${flags}` : ''}`);
	}
}

function editDistance(a, b) {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i += 1) {
		let previous = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const current = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
			previous = current;
		}
	}
	return row[b.length];
}

async function loadInstalledCatalog(projectRoot) {
	try {
		const runtimeDir = fs.realpathSync(path.join(projectRoot, 'node_modules', '@flue', 'runtime'));
		const runtimeVersion = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'package.json'), 'utf8')).version;
		// Pi is a dependency of @flue/runtime: look beside it (pnpm) and up the tree (npm, yarn).
		let dir = path.dirname(runtimeDir);
		let piDir;
		for (;;) {
			for (const candidate of [path.join(dir, '@earendil-works', 'pi-ai'), path.join(dir, 'node_modules', '@earendil-works', 'pi-ai')]) {
				if (!piDir && fs.existsSync(path.join(candidate, 'package.json'))) piDir = candidate;
			}
			const parent = path.dirname(dir);
			if (piDir || parent === dir) break;
			dir = parent;
		}
		if (!piDir) return undefined;
		const piVersion = JSON.parse(fs.readFileSync(path.join(piDir, 'package.json'), 'utf8')).version;
		const mod = await import(pathToFileURL(path.join(piDir, 'dist', 'providers', 'all.js')).href);
		const providers = mod.getBuiltinProviders();
		const models = providers.flatMap((provider) =>
			mod.getBuiltinModels(provider).map((model) => ({
				specifier: `${provider}/${model.id}`,
				provider,
				id: model.id,
				name: model.name,
				reasoning: model.reasoning,
				input: model.input,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			})),
		);
		return { source: `installed @flue/runtime ${runtimeVersion} (pi-ai ${piVersion})`, providers, models };
	} catch {
		return undefined;
	}
}

async function loadPublishedCatalog() {
	try {
		const res = await fetch('https://flueframework.com/models.json');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const specifiers = await res.json();
		const models = specifiers.map((specifier) => {
			const [provider, ...rest] = specifier.split('/');
			return { specifier, provider, id: rest.join('/') };
		});
		return {
			source: 'flueframework.com/models.json (latest Flue release — may differ from an older installed version)',
			providers: [...new Set(models.map((model) => model.provider))],
			models,
		};
	} catch (err) {
		console.error(`flue-models: no installed @flue/runtime found and flueframework.com/models.json is unreachable (${err instanceof Error ? err.message : String(err)}).`);
		process.exit(2);
	}
}
