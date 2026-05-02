// Endpoint registry. Persists named Flue HTTP endpoints to a JSON file.
// Default location: $FLUE_LOOM_HOME or ~/.config/flue-loom/endpoints.json.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface Endpoint {
	name: string;
	url: string;
}

export interface RegistryState {
	endpoints: Endpoint[];
	defaultName?: string;
}

function registryPath(): string {
	const home = process.env.FLUE_LOOM_HOME ?? join(homedir(), '.config', 'flue-loom');
	return join(home, 'endpoints.json');
}

async function readRegistry(): Promise<RegistryState> {
	try {
		const raw = await readFile(registryPath(), 'utf-8');
		const parsed = JSON.parse(raw) as RegistryState;
		// Defensive defaults.
		if (!Array.isArray(parsed.endpoints)) parsed.endpoints = [];
		return parsed;
	} catch (err) {
		// ENOENT (no registry yet) is the legitimate cold-start path; silent.
		// Anything else (corrupted JSON, EACCES, EIO) is a real problem the
		// user should know about — log to stderr (stdio MCP reserves stdout
		// for JSON-RPC) but still return an empty registry so subsequent
		// add_endpoint calls have a chance to repair the file.
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code !== 'ENOENT') {
			const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			console.error(`[flue-loom-mcp-server] registry read failed (${detail}); starting with empty registry`);
		}
		return { endpoints: [] };
	}
}

async function writeRegistry(state: RegistryState): Promise<void> {
	const path = registryPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

// Serialize all registry mutations to avoid concurrent read-modify-write races
// when MCP processes multiple tools/call requests in parallel.
let mutationChain: Promise<unknown> = Promise.resolve();

function withMutation<T>(work: () => Promise<T>): Promise<T> {
	const next = mutationChain.then(work, work);
	mutationChain = next.catch(() => {
		/* swallow chain errors so future calls don't reject */
	});
	return next;
}

export async function listEndpoints(): Promise<RegistryState> {
	return withMutation(() => readRegistry());
}

export async function addEndpoint(name: string, url: string, makeDefault?: boolean): Promise<RegistryState> {
	return withMutation(async () => {
		const state = await readRegistry();
		const existing = state.endpoints.findIndex((e) => e.name === name);
		if (existing >= 0) {
			state.endpoints[existing] = { name, url };
		} else {
			state.endpoints.push({ name, url });
		}
		if (makeDefault) state.defaultName = name;
		// Auto-promote on first registration so the cold-start case has a default.
		if (!state.defaultName && state.endpoints.length === 1) state.defaultName = name;
		await writeRegistry(state);
		return state;
	});
}

export async function removeEndpoint(name: string): Promise<RegistryState> {
	return withMutation(async () => {
		const state = await readRegistry();
		const before = state.endpoints.length;
		state.endpoints = state.endpoints.filter((e) => e.name !== name);
		// Short-circuit when the name wasn't present — no point rewriting the
		// file just to produce an identical state, and matches the docstring's
		// "no-op when name is absent" claim more honestly.
		if (state.endpoints.length === before) return state;
		if (state.defaultName === name) state.defaultName = state.endpoints[0]?.name;
		await writeRegistry(state);
		return state;
	});
}

/**
 * Resolve an endpoint reference to a URL.
 *
 * Order:
 *   1. Explicit URL (starts with http:// or https://)
 *   2. Registry by name
 *   3. Registry default
 *   4. Built-in fallback (http://localhost:3583), only when registry is empty
 */
export async function resolveEndpoint(ref?: string): Promise<string> {
	// Goes through the mutation chain so a concurrent add/remove can't be
	// read partially.
	if (ref && /^https?:\/\//.test(ref)) return ref.replace(/\/$/, '');

	return withMutation(async () => {
		const state = await readRegistry();

		if (ref) {
			const match = state.endpoints.find((e) => e.name === ref);
			if (match) return match.url.replace(/\/$/, '');
			throw new Error(`Endpoint "${ref}" not found in registry. Add it with flue_add_endpoint.`);
		}

		if (state.defaultName) {
			const match = state.endpoints.find((e) => e.name === state.defaultName);
			if (match) return match.url.replace(/\/$/, '');
			// Default name set but the entry is gone — surface as a config error
			// rather than silently falling back to localhost.
			throw new Error(
				`Default endpoint "${state.defaultName}" is registered but no longer exists in the endpoints list. ` +
					`Add it back with flue_add_endpoint or set a different default.`,
			);
		}

		// Cold start: registry has no entries and no default. Localhost is the
		// only sane default for the bundled-with-flue-dev case. If the registry
		// has entries but no default was ever set, suggest configuring one.
		if (state.endpoints.length > 0) {
			throw new Error(
				`No default endpoint configured (registry has ${state.endpoints.length} entries: ${state.endpoints
					.map((e) => `"${e.name}"`)
					.join(', ')}). ` +
					`Pass an explicit endpoint URL/name, or call flue_add_endpoint with default=true.`,
			);
		}
		return 'http://localhost:3583';
	});
}
