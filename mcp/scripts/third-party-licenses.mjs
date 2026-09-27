// Write dist/THIRD_PARTY_LICENSES.md for every package tsdown inlined into
// dist/server.mjs (found from the bundle's `//#region node_modules/...`
// markers), so redistributing the self-contained server keeps their notices.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = readFileSync(join(root, 'dist', 'server.mjs'), 'utf-8');

const packageDirs = new Set();
for (const [, path] of bundle.matchAll(/^\/\/#region (node_modules\/\S+)$/gm)) {
	const match = path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
	if (match) packageDirs.add(match[1]);
}

const sections = [...packageDirs]
	.map((dir) => {
		const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf-8'));
		const licenseFile = readdirSync(join(root, dir)).find((file) => /^licen[cs]e(\.(md|txt))?$/i.test(file));
		const text = licenseFile ? readFileSync(join(root, dir, licenseFile), 'utf-8').trim() : `License: ${pkg.license ?? 'unknown'} (no license file shipped)`;
		const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
		return { name: pkg.name, version: pkg.version, license: pkg.license ?? 'unknown', repository, text };
	})
	.sort((a, b) => a.name.localeCompare(b.name));

if (sections.length === 0) throw new Error('no bundled packages found in dist/server.mjs — build first');

const body = [
	'# Third-party licenses',
	'',
	'`dist/server.mjs` bundles the following packages. Their licenses follow.',
	'',
	...sections.map((s) => `- ${s.name}@${s.version} (${s.license})`),
	'',
	...sections.flatMap((s) => [`## ${s.name}@${s.version} — ${s.license}`, '', ...(s.repository ? [`Source: ${s.repository}`, ''] : []), '```text', s.text, '```', '']),
].join('\n');
writeFileSync(join(root, 'dist', 'THIRD_PARTY_LICENSES.md'), body);
console.log(`wrote dist/THIRD_PARTY_LICENSES.md (${sections.map((s) => s.name).join(', ')})`);
