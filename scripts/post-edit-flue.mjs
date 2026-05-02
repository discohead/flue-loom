#!/usr/bin/env node
// PostToolUse hook for flue-loom.
// Lints the `triggers` export shape on Edit/Write of files matching
// **/agents/*.{ts,js,mts,mjs}. Uses the EXACT regex from build.ts so
// our lint matches Flue's parser bit-for-bit.
//
// Reads JSON hook input on stdin: { tool_name, tool_input: { file_path, ... }, ... }
// Emits non-blocking warnings via stdout JSON.

import { readFileSync } from 'node:fs';

// Mirror packages/sdk/src/build.ts:283 — must stay in sync with @flue/sdk.
const TRIGGERS_REGEX = /export\s+const\s+triggers\s*=\s*\{([^}]*)\}/;
const WEBHOOK_REGEX = /webhook\s*:\s*true/;
const CRON_REGEX = /cron\s*:\s*['"]([^'"]+)['"]/;

const AGENT_FILE_REGEX = /\/agents\/[^/]+\.(ts|js|mts|mjs)$/;

let input = '';
process.stdin.setEncoding('utf-8');
for await (const chunk of process.stdin) input += chunk;

let payload;
try {
	payload = JSON.parse(input || '{}');
} catch (err) {
	// Hook payload shape may have changed in a Claude Code upgrade.
	// Surface to stderr (non-blocking) so the user notices the lint
	// stopped working, then exit 0 so we don't fail the parent tool.
	console.error(
		`flue-loom hook: malformed input — ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(0);
}

// Normalize separators so the regex matches on Windows hook payloads too —
// Claude Code passes OS-native paths (e.g. C:\…\agents\foo.ts) and the regex
// is forward-slash anchored.
const filePath = (
	payload?.tool_input?.file_path ??
	payload?.tool_input?.path ??
	payload?.toolInput?.file_path ??
	''
).replace(/\\/g, '/');

if (!filePath || !AGENT_FILE_REGEX.test(filePath)) {
	process.exit(0);
}

let source = '';
try {
	source = readFileSync(filePath, 'utf-8');
} catch (err) {
	// ENOENT is fine — the file may have been deleted/moved between the
	// edit and the hook firing. EACCES / EIO / other codes are real
	// problems the user needs to know about.
	const code = (err && typeof err === 'object' && 'code' in err) ? String(err.code) : '';
	if (code !== 'ENOENT') {
		console.error(
			`flue-loom hook: cannot read ${filePath} (${code || (err instanceof Error ? err.message : String(err))})`,
		);
	}
	process.exit(0);
}

const warnings = [];

const triggersMatch = source.match(TRIGGERS_REGEX);
if (!triggersMatch) {
	warnings.push(
		`No \`export const triggers = { ... }\` found. The agent will be CLI-only (FLUE_MODE=local). If you intended this agent to be invocable in production, add e.g. \`export const triggers = { webhook: true };\` as a literal object expression.`,
	);
} else {
	const block = triggersMatch[1] ?? '';
	const hasWebhook = WEBHOOK_REGEX.test(block);
	const cronMatch = block.match(CRON_REGEX);

	if (!hasWebhook && !cronMatch) {
		warnings.push(
			`\`triggers = {...}\` parsed but no recognized keys (webhook/cron) found. Flue will treat this agent as trigger-less.`,
		);
	}

	// Detect spread or computed key — these silently break the regex
	// even though the file may compile.
	if (/\.\.\./.test(block)) {
		warnings.push(
			`\`triggers\` block contains a spread (\`...\`). The build-time regex won't parse spread; the resulting triggers will likely be empty. Use a literal object expression.`,
		);
	}
	if (/\[/.test(block)) {
		warnings.push(
			`\`triggers\` block contains a computed key (\`[...]\`). Not parseable by the build-time regex. Use literal keys (\`webhook:\`, \`cron:\`).`,
		);
	}
}

if (warnings.length === 0) {
	process.exit(0);
}

const message = `flue-loom: ${filePath}\n  - ${warnings.join('\n  - ')}`;

// Emit a non-blocking notification. Different Claude Code versions accept
// different shapes; print a simple text message and exit 0.
console.log(
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PostToolUse',
			additionalContext: message,
		},
	}),
);
process.exit(0);
