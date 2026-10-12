// Shared helpers: throwaway Flue projects on disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Create a temp project from a { relativePath: contents } map. Returns its root. */
export function project(files, { deps = { '@flue/runtime': '^2.1.1', '@flue/vite': '^2.1.1' } } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-loom-test-'));
	const all = { 'package.json': JSON.stringify({ name: 'fixture', type: 'module', dependencies: deps }), ...files };
	for (const [rel, contents] of Object.entries(all)) {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, contents);
	}
	return root;
}

export function cleanup(root) {
	fs.rmSync(root, { recursive: true, force: true });
}

export const messages = (findings) => findings.map((finding) => `${finding.level}: ${finding.message}`);
