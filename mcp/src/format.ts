// Markdown formatters for tool responses. Used when callers pass
// response_format='markdown'. JSON output is the default — markdown is
// for human-facing chat clients (Claude Desktop, ChatGPT, Cursor).

import type { RegistryState, Endpoint } from './registry.ts';

interface AgentLike {
	name: string;
	triggers?: unknown;
}

export function formatAgentsMarkdown(endpoint: string, agents: unknown[]): string {
	const lines: string[] = [];
	lines.push(`# Agents at \`${endpoint}\``);
	lines.push('');
	if (agents.length === 0) {
		lines.push('_No agents registered._');
		return lines.join('\n');
	}
	lines.push('| Agent | Webhook | Cron |');
	lines.push('|---|---|---|');
	for (const a of agents as AgentLike[]) {
		const t = (a.triggers ?? {}) as { webhook?: boolean; cron?: string };
		lines.push(
			`| \`${a.name}\` | ${t.webhook ? '✓' : ''} | ${t.cron ? '`' + t.cron + '`' : ''} |`,
		);
	}
	lines.push('');
	lines.push(`_${agents.length} agent${agents.length === 1 ? '' : 's'} total._`);
	return lines.join('\n');
}

export function formatEndpointsMarkdown(state: RegistryState): string {
	const lines: string[] = [];
	lines.push('# Registered Endpoints');
	lines.push('');
	if (state.endpoints.length === 0) {
		lines.push('_No endpoints registered. Use `flue_add_endpoint` to add one._');
		return lines.join('\n');
	}
	lines.push('| Default | Name | URL |');
	lines.push('|---|---|---|');
	for (const e of state.endpoints) {
		const isDefault = e.name === state.defaultName ? '★' : '';
		lines.push(`| ${isDefault} | \`${e.name}\` | ${e.url} |`);
	}
	lines.push('');
	lines.push(`_${state.endpoints.length} endpoint${state.endpoints.length === 1 ? '' : 's'} total._`);
	return lines.join('\n');
}

export function formatInvokeMarkdown(
	endpoint: string,
	agent: string,
	sessionId: string,
	mode: 'sync' | 'webhook',
	body: unknown,
): string {
	const lines: string[] = [];
	lines.push(`# Invoke \`${agent}\` (${mode})`);
	lines.push('');
	lines.push(`- **Endpoint**: \`${endpoint}\``);
	lines.push(`- **Session**: \`${sessionId}\``);
	lines.push('');
	if (mode === 'webhook') {
		const w = body as { status?: number };
		lines.push(`Webhook accepted (HTTP ${w.status ?? '?'}).`);
	} else {
		lines.push('## Result');
		lines.push('');
		lines.push('```json');
		lines.push(JSON.stringify(body, null, 2));
		lines.push('```');
	}
	return lines.join('\n');
}

export function formatStreamMarkdown(
	endpoint: string,
	agent: string,
	sessionId: string,
	text: string,
	result: unknown,
	eventCount: number,
	truncated: boolean,
	truncationNote?: string,
): string {
	const lines: string[] = [];
	lines.push(`# Stream \`${agent}\``);
	lines.push('');
	lines.push(`- **Endpoint**: \`${endpoint}\``);
	lines.push(`- **Session**: \`${sessionId}\``);
	lines.push(`- **Events**: ${eventCount}${truncated ? ' (truncated)' : ''}`);
	lines.push('');
	if (text) {
		lines.push('## Output');
		lines.push('');
		lines.push(text.trim());
		lines.push('');
	}
	if (result !== undefined) {
		lines.push('## Result');
		lines.push('');
		lines.push('```json');
		lines.push(JSON.stringify(result, null, 2));
		lines.push('```');
	}
	if (truncationNote) {
		lines.push('');
		lines.push(`> **Note**: ${truncationNote}`);
	}
	return lines.join('\n');
}

// Re-export Endpoint type for callers that import from './format.ts'.
export type { Endpoint };
