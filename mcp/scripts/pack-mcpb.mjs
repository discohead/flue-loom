// Build flue-loom-<version>.mcpb (a one-click Claude Desktop bundle) from the
// already-built dist/: stage manifest + server, validate, pack.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const stage = join(root, '.mcpb-build');
const output = join(root, `flue-loom-${version}.mcpb`);
const mcpb = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpb.cmd' : 'mcpb');

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, 'mcpb', 'manifest.json'), 'utf-8'));
manifest.version = version;
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
copyFileSync(join(root, 'dist', 'server.mjs'), join(stage, 'server', 'server.mjs'));
copyFileSync(join(root, 'dist', 'THIRD_PARTY_LICENSES.md'), join(stage, 'THIRD_PARTY_LICENSES.md'));
copyFileSync(join(root, '..', 'LICENSE'), join(stage, 'LICENSE'));

execFileSync(mcpb, ['validate', join(stage, 'manifest.json')], { stdio: 'inherit' });
execFileSync(mcpb, ['pack', stage, output], { stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
console.log(`\n${output}`);
