// Agent registry: named Flue agent mount URLs, persisted as JSON so every MCP
// host on the machine shares them. Location: $FLUE_LOOM_HOME/agents.json,
// default ~/.config/flue-loom/agents.json. Tokens are never stored — entries
// name the environment variables that hold them.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RegisteredAgent {
	name: string;
	/** Agent mount URL (app.ts route), without a conversation id. */
	url: string;
	description?: string;
	/** Environment variable holding a bearer token for this agent's routes. */
	token_env?: string;
	/** Static, non-secret headers sent with every request. */
	headers?: Record<string, string>;
	/** Header name → environment variable holding its value (for secret headers). */
	header_env?: Record<string, string>;
}

interface RegistryFile {
	version: 1;
	agents: RegisteredAgent[];
}

export function registryHome(): string {
	return process.env.FLUE_LOOM_HOME || join(homedir(), '.config', 'flue-loom');
}

export function registryPath(): string {
	return join(registryHome(), 'agents.json');
}

async function readRegistry(): Promise<RegistryFile> {
	try {
		const parsed = JSON.parse(await readFile(registryPath(), 'utf-8')) as Partial<RegistryFile>;
		const agents = Array.isArray(parsed.agents) ? parsed.agents.filter(isEntry) : [];
		return { version: 1, agents };
	} catch (err) {
		// A missing file is the normal cold start. Anything else (corrupt JSON,
		// permissions) is reported on stderr — stdout carries JSON-RPC — and the
		// registry reads as empty so a later write can repair it.
		if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[flue-loom] could not read ${registryPath()} (${detail}); treating the registry as empty`);
		}
		return { version: 1, agents: [] };
	}
}

function isEntry(value: unknown): value is RegisteredAgent {
	const entry = value as RegisteredAgent | null;
	return typeof entry?.name === 'string' && typeof entry.url === 'string';
}

async function writeRegistry(state: RegistryFile): Promise<void> {
	const path = registryPath();
	await mkdir(dirname(path), { recursive: true });
	// Write-then-rename so a crash never leaves a half-written registry.
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(state, null, '\t')}\n`, 'utf-8');
	await rename(temp, path);
}

// Serialize registry access: MCP hosts may run several tool calls concurrently.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
	const next = queue.then(work, work);
	queue = next.catch(() => undefined);
	return next;
}

export function listRegisteredAgents(): Promise<RegisteredAgent[]> {
	return serialized(async () => (await readRegistry()).agents);
}

export function findRegisteredAgent(name: string): Promise<RegisteredAgent | undefined> {
	return serialized(async () => (await readRegistry()).agents.find((agent) => agent.name === name));
}

export function upsertAgent(entry: RegisteredAgent): Promise<{ replaced: boolean }> {
	return serialized(async () => {
		const state = await readRegistry();
		const index = state.agents.findIndex((agent) => agent.name === entry.name);
		if (index >= 0) state.agents[index] = entry;
		else state.agents.push(entry);
		await writeRegistry(state);
		return { replaced: index >= 0 };
	});
}

export function removeAgent(name: string): Promise<{ removed: boolean }> {
	return serialized(async () => {
		const state = await readRegistry();
		const agents = state.agents.filter((agent) => agent.name !== name);
		if (agents.length === state.agents.length) return { removed: false };
		await writeRegistry({ version: 1, agents });
		return { removed: true };
	});
}
