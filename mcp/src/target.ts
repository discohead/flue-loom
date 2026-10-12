// Resolve a tool call's addressing fields to one conversation URL plus the
// credentials configured for it. Addressing follows Flue 2: an agent is
// reached at its app.ts mount, and a conversation is the mount plus an id.

import { randomBytes } from 'node:crypto';

import { discoverProject, baseUrl, trimSlash } from './project.ts';
import { type RegisteredAgent, findRegisteredAgent, listRegisteredAgents } from './registry.ts';

export interface TargetInput {
	agent?: string;
	url?: string;
	conversation_url?: string;
	conversation_id?: string;
}

export interface ResolvedTarget {
	/** Human label: the agent name, else the mount URL. */
	label: string;
	mountUrl: string;
	conversationId: string;
	conversationUrl: string;
	/** True when the id was generated because the caller omitted it. */
	generatedId: boolean;
	headers: Record<string, string>;
	token?: string;
	/** Credential problems worth surfacing (e.g. an unset token variable). */
	notes: string[];
}

/** A caller mistake the tool reports as-is. */
export class TargetError extends Error {}

// Only FLUE_* variables may be sent as credentials, so a tool call can never
// be steered into shipping unrelated secrets (cloud keys, API keys) to a URL.
export const CREDENTIAL_ENV_PATTERN = /^FLUE_[A-Z0-9_]+$/;

export async function resolveTarget(
	input: TargetInput,
	{ requireConversation }: { requireConversation: boolean },
): Promise<ResolvedTarget> {
	const given = [input.agent, input.url, input.conversation_url].filter((value) => value !== undefined && value !== '');
	if (given.length === 0) {
		throw new TargetError(`Say which agent to talk to: pass \`agent\` (a registered or discovered name), \`url\` (the agent's mount URL), or \`conversation_url\`. ${await knownAgentsHint()}`);
	}
	if (given.length > 1) throw new TargetError('Pass only one of `agent`, `url`, or `conversation_url`.');

	let mountUrl: string;
	let conversationId = input.conversation_id?.trim() || undefined;
	let label: string;
	let registered: RegisteredAgent | undefined;

	if (input.conversation_url) {
		if (conversationId) throw new TargetError('`conversation_url` already names the conversation; drop `conversation_id`.');
		const parsed = parseHttpUrl(input.conversation_url, 'conversation_url');
		const segments = parsed.pathname.split('/').filter(Boolean);
		const last = segments.pop();
		if (!last || segments.length === 0) {
			throw new TargetError('`conversation_url` must be an agent mount plus a conversation id, e.g. http://localhost:5173/agents/support/ticket-42.');
		}
		conversationId = decodeURIComponent(last);
		mountUrl = `${parsed.origin}/${segments.join('/')}`;
		label = mountUrl;
	} else if (input.url) {
		mountUrl = input.url.startsWith('/') ? `${baseUrl()}${trimSlash(input.url)}` : trimSlash(parseHttpUrl(input.url, 'url').href);
		label = mountUrl;
	} else {
		const name = input.agent as string;
		registered = await findRegisteredAgent(name);
		if (registered) {
			mountUrl = trimSlash(registered.url);
		} else {
			const project = discoverProject();
			const lower = name.toLowerCase();
			const match = project?.agents.find((agent) => agent.name.toLowerCase() === lower || agent.export.toLowerCase() === lower);
			if (!match) throw new TargetError(`No agent named "${name}". ${await knownAgentsHint()}`);
			if (!match.url) {
				throw new TargetError(`"${name}" is mounted at ${match.path}, which has route parameters — pass the concrete mount as \`url\`.`);
			}
			mountUrl = match.url;
		}
		label = name;
	}

	// Credentials: from the registry entry the call names, or one registered at exactly this mount.
	registered ??= (await listRegisteredAgents()).find((agent) => trimSlash(agent.url) === mountUrl);

	let generatedId = false;
	if (!conversationId) {
		if (requireConversation) throw new TargetError('Pass `conversation_id` (or a full `conversation_url`) to say which conversation.');
		conversationId = `mcp-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
		generatedId = true;
	}
	if (conversationId.includes('/')) throw new TargetError('`conversation_id` cannot contain "/".');

	const { headers, token, notes } = credentialsFor(registered);
	return {
		label,
		mountUrl,
		conversationId,
		conversationUrl: `${mountUrl}/${encodeURIComponent(conversationId)}`,
		generatedId,
		headers,
		token,
		notes,
	};
}

function credentialsFor(agent: RegisteredAgent | undefined): Pick<ResolvedTarget, 'headers' | 'token' | 'notes'> {
	const headers: Record<string, string> = { ...(agent?.headers ?? {}) };
	const notes: string[] = [];
	let token: string | undefined;
	if (agent?.token_env) {
		token = readCredential(agent.token_env, notes);
	}
	for (const [header, variable] of Object.entries(agent?.header_env ?? {})) {
		const value = readCredential(variable, notes);
		if (value !== undefined) headers[header] = value;
	}
	return { headers, token, notes };
}

function readCredential(variable: string, notes: string[]): string | undefined {
	if (!CREDENTIAL_ENV_PATTERN.test(variable)) {
		notes.push(`Ignored credential variable ${variable}: only FLUE_* variables are sent.`);
		return undefined;
	}
	const value = process.env[variable];
	if (!value) notes.push(`${variable} is not set in the MCP server's environment; sent without it.`);
	return value || undefined;
}

function parseHttpUrl(value: string, field: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new TargetError(`\`${field}\` is not a valid URL: ${value}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new TargetError(`\`${field}\` must be an http(s) URL.`);
	}
	parsed.search = '';
	parsed.hash = '';
	return parsed;
}

async function knownAgentsHint(): Promise<string> {
	const registered = (await listRegisteredAgents()).map((agent) => agent.name);
	const project = discoverProject();
	const discovered = project?.agents.filter((agent) => agent.url).map((agent) => agent.name) ?? [];
	const parts: string[] = [];
	if (registered.length > 0) parts.push(`registered: ${registered.join(', ')}`);
	if (discovered.length > 0) parts.push(`in the local project (at ${project?.base_url}): ${discovered.join(', ')}`);
	return parts.length > 0 ? `Known agents — ${parts.join('; ')}.` : 'No agents are registered (flue_add_agent) and no local Flue project mounts were found (flue_list_agents).';
}
