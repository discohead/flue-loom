// Projections of SDK objects into tool output, plus the Markdown text form.

import type { FlueConversationMessage, FlueConversationSettlement, FlueConversationSnapshot } from '@flue/sdk';

import { CHARACTER_LIMIT } from './constants.ts';
import type { ToolActivity } from './flue.ts';
import type { ProjectInfo } from './project.ts';
import type { RegisteredAgent } from './registry.ts';

const PREVIEW_LIMIT = 4_000;

export function truncate(text: string, limit = CHARACTER_LIMIT): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	return { text: `${text.slice(0, limit)}\n… [truncated ${text.length - limit} characters]`, truncated: true };
}

/** Keep large JSON values from flooding the result; small ones pass through. */
export function preview(value: unknown): unknown {
	if (value === undefined) return undefined;
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		return String(value);
	}
	if (json === undefined || json.length <= PREVIEW_LIMIT) return value;
	return { truncated: true, preview: `${json.slice(0, PREVIEW_LIMIT)}…` };
}

// ─── Replies ────────────────────────────────────────────────────────────────

export interface ReplyOutput {
	agent: string;
	conversation_url: string;
	conversation_id: string;
	submission_id: string;
	outcome: 'completed' | 'pending';
	uid?: string;
	deduplicated?: boolean;
	text?: string;
	data?: Record<string, unknown[]>;
	metadata?: Record<string, unknown>;
	answered_by_submission_id?: string;
	activity: ToolActivity[];
	notes?: string[];
	truncated?: boolean;
}

export function replyMarkdown(out: ReplyOutput, waitedSeconds?: number): string {
	const head = `**${out.agent}** · conversation \`${out.conversation_id}\` · submission \`${out.submission_id}\``;
	const lines: string[] = [];
	if (out.outcome === 'completed') {
		lines.push(`${head} — completed${out.deduplicated ? ' (deduplicated: an earlier send with this idempotency_key)' : ''}`, '', out.text?.trim() ? out.text : '_(no reply text)_');
		if (out.answered_by_submission_id) lines.push('', `_Answered together with submission ${out.answered_by_submission_id} (the message joined a response already in progress)._`);
	} else {
		const why = waitedSeconds === undefined ? 'accepted; not waiting for the reply' : `no reply yet after ${waitedSeconds} s — the agent is still working`;
		lines.push(`${head} — ${why}.`, '', `Call flue_read_reply with conversation_id "${out.conversation_id}" and submission_id "${out.submission_id}" to wait again, flue_get_conversation to look, or flue_abort to stop it.`);
	}
	const data = Object.entries(out.data ?? {});
	if (data.length > 0) lines.push('', `Data parts: ${data.map(([name, values]) => `${name} ×${values.length}`).join(', ')} (in structured output / response_format "json").`);
	if (out.activity.length > 0) lines.push('', `Tools: ${out.activity.map(activityLabel).join(' · ')}`);
	if (out.notes?.length) lines.push('', ...out.notes.map((note) => `Note: ${note}`));
	lines.push('', `Continue with conversation_id "${out.conversation_id}"${out.uid ? ` (uid ${out.uid})` : ''} at ${out.conversation_url}.`);
	return lines.join('\n');
}

function activityLabel(entry: ToolActivity): string {
	const mark = entry.status === 'ok' ? '✓' : entry.status === 'error' ? '✗' : '…';
	const time = entry.duration_ms !== undefined ? ` ${entry.duration_ms} ms` : '';
	const error = entry.error ? ` (${entry.error.slice(0, 160)})` : '';
	return `${entry.tool} ${mark}${time}${error}`;
}

// ─── History ────────────────────────────────────────────────────────────────

export interface HistoryMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	purpose: string;
	display: string;
	submission_id?: string;
	text: string;
	tool_calls?: Array<{ tool: string; tool_call_id: string; state: string; input?: unknown; output?: unknown; error?: string }>;
	data?: Record<string, unknown[]>;
	files?: Array<{ media_type: string; filename?: string; url?: string }>;
	signal?: { tag_name?: string; attributes?: Record<string, string> };
	settlement?: 'failed' | 'aborted';
	metadata?: Record<string, unknown>;
}

export function projectMessage(message: FlueConversationMessage): HistoryMessage {
	const text: string[] = [];
	const toolCalls: NonNullable<HistoryMessage['tool_calls']> = [];
	const data: Record<string, unknown[]> = {};
	const files: NonNullable<HistoryMessage['files']> = [];
	for (const part of message.parts) {
		if (part.type === 'text') text.push(part.text);
		else if (part.type === 'dynamic-tool') {
			toolCalls.push({
				tool: part.toolName,
				tool_call_id: part.toolCallId,
				state: part.state,
				input: preview(part.input),
				...(part.state === 'output-available' ? { output: preview(part.output) } : {}),
				...(part.state === 'output-error' ? { error: part.errorText } : {}),
			});
		} else if (part.type === 'file') {
			files.push({ media_type: part.mediaType, ...(part.filename ? { filename: part.filename } : {}), ...(part.url && !part.url.startsWith('data:') ? { url: part.url } : {}) });
		} else if (part.type.startsWith('data-')) {
			const name = part.type.slice('data-'.length);
			(data[name] ??= []).push(preview((part as { data: unknown }).data));
		}
		// Reasoning parts are omitted: they are the model's scratchpad, not the conversation.
	}
	return {
		id: message.id,
		role: message.role,
		purpose: message.purpose,
		display: message.display,
		...(message.submissionId ? { submission_id: message.submissionId } : {}),
		text: text.join(''),
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		...(Object.keys(data).length > 0 ? { data } : {}),
		...(files.length > 0 ? { files } : {}),
		...(message.signal ? { signal: { tag_name: message.signal.tagName, attributes: message.signal.attributes } } : {}),
		...(message.settlement ? { settlement: message.settlement.outcome } : {}),
		...(message.metadata ? { metadata: preview(message.metadata) as Record<string, unknown> } : {}),
	};
}

export function projectSettlement(settlement: FlueConversationSettlement): Record<string, unknown> {
	return {
		submission_id: settlement.submissionId,
		outcome: settlement.outcome,
		...(settlement.answeredBySubmissionId ? { answered_by_submission_id: settlement.answeredBySubmissionId } : {}),
		...(settlement.error !== undefined ? { error: preview(settlement.error) } : {}),
	};
}

export function historyMarkdown(
	label: string,
	conversationUrl: string,
	snapshot: FlueConversationSnapshot | undefined,
	messages: HistoryMessage[],
	total: number,
): string {
	if (!snapshot) return `**${label}** · no conversation exists at ${conversationUrl} yet — flue_send_message creates it.`;
	const lines = [`**${label}** · ${conversationUrl} — ${total} message(s)${messages.length < total ? `, showing the last ${messages.length}` : ''}, ${snapshot.settlements.length} settled submission(s)`, ''];
	for (const message of messages) {
		const tags: string[] = [message.role];
		if (message.purpose !== message.role) tags.push(message.purpose);
		if (message.signal?.tag_name) tags.push(`signal ${message.signal.tag_name}`);
		if (message.submission_id) tags.push(message.submission_id);
		if (message.settlement) tags.push(message.settlement);
		lines.push(`[${tags.join(' · ')}] ${message.text.trim() || (message.tool_calls ? '' : '_(no text)_')}`.trimEnd());
		for (const call of message.tool_calls ?? []) {
			const state = call.state === 'output-available' ? '✓' : call.state === 'output-error' ? `✗ ${call.error ?? ''}` : '…';
			lines.push(`    tool ${call.tool} ${state}`.trimEnd());
		}
		for (const [name, values] of Object.entries(message.data ?? {})) lines.push(`    data ${name} ×${values.length}`);
		for (const file of message.files ?? []) lines.push(`    file ${file.filename ?? file.media_type}`);
	}
	const failed = snapshot.settlements.filter((settlement) => settlement.outcome !== 'completed');
	if (failed.length > 0) {
		lines.push('', `Unsuccessful submissions: ${failed.map((settlement) => `${settlement.submissionId} ${settlement.outcome}`).join(', ')}`);
	}
	return lines.join('\n');
}

// ─── Agents ─────────────────────────────────────────────────────────────────

export function agentsMarkdown(
	registered: Array<RegisteredAgent & { credentials: string }>,
	registryFile: string,
	project: ProjectInfo | null,
): string {
	const lines: string[] = [];
	if (registered.length > 0) {
		lines.push(`Registered agents (${registryFile}):`);
		for (const agent of registered) {
			lines.push(`- ${agent.name} → ${agent.url}${agent.credentials !== 'none' ? ` [${agent.credentials}]` : ''}${agent.description ? ` — ${agent.description}` : ''}`);
		}
	} else {
		lines.push(`No registered agents (${registryFile}). Register deployed agents with flue_add_agent.`);
	}
	lines.push('');
	if (project) {
		lines.push(`Local Flue project ${project.root} (dev server assumed at ${project.base_url}):`);
		if (project.agents.length === 0) {
			lines.push(project.uses_glob ? '- app.ts builds its routes with import.meta.glob; mounts could not be read statically.' : project.app ? '- app.ts mounts no agents.' : '- No app.ts: agents run with `flue run`, not over HTTP.');
		}
		for (const agent of project.agents) {
			lines.push(`- ${agent.name} → ${agent.url ?? `${agent.path} (has route params)`} (${agent.export})`);
		}
	} else {
		lines.push('No local Flue project found (set FLUE_LOOM_PROJECT_DIR or pass project_dir).');
	}
	lines.push('', 'Talk to one with flue_send_message { agent, message }; the reply includes the conversation_id to continue.');
	return lines.join('\n');
}
