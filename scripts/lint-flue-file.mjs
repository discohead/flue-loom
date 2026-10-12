#!/usr/bin/env node
// PostToolUse hook (Edit|Write) for flue-loom.
//
// Lints Flue 2 project files as Claude edits them — agent modules, SKILL.md,
// wrangler.jsonc, vite.config.*, flue.config.* — and hands findings back to
// Claude as additionalContext. Never blocks and never fails the tool call:
// every problem path exits 0.
//
// Reads the hook payload on stdin: { cwd, tool_name, tool_input: { file_path } }.

import path from 'node:path';
import { findFlueProjectRoot } from './lib/flue-project.mjs';
import { formatFindings, lintFile } from './lib/lint.mjs';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

let payload;
try {
	payload = JSON.parse(input || '{}');
} catch (err) {
	// Surface on stderr so a Claude Code payload change doesn't make the lint
	// silently stop working; exit 0 so the edit itself is unaffected.
	console.error(`flue-loom lint: malformed hook input — ${err instanceof Error ? err.message : String(err)}`);
	process.exit(0);
}

const rawPath = payload?.tool_input?.file_path ?? payload?.tool_input?.path;
if (typeof rawPath !== 'string' || rawPath === '') process.exit(0);

const filePath = path.resolve(typeof payload.cwd === 'string' ? payload.cwd : process.cwd(), rawPath);
const root = findFlueProjectRoot(path.dirname(filePath));
if (!root) process.exit(0);

let result;
try {
	result = await lintFile(root, filePath);
} catch (err) {
	console.error(`flue-loom lint: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(0);
}

if (result.findings.length === 0) process.exit(0);

const rel = path.relative(root, filePath).split(path.sep).join('/');
console.log(
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PostToolUse',
			additionalContext: formatFindings(rel, result.findings, result.scanner),
		},
	}),
);
