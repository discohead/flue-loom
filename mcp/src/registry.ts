// Endpoint registry. Persists named Flue HTTP endpoints to a JSON file.
// Default location: $FLUE_LOOM_HOME or ~/.config/flue-loom/endpoints.json.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
	const home = process.env.FLUE_LOOM_HOME ?? `${homedir()}/.config/flue-loom`;
	return `${home}/endpoints.json`;
}

async function readRegistry(): Promise<RegistryState> {
	try {
		const raw = await readFile(registryPath(), 'utf-8');
		const parsed = JSON.parse(raw) as RegistryState;
		// Defensive defaults.
		if (!Array.isArray(parsed.endpoints)) parsed.endpoints = [];
		return parsed;
	} catch {
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
		if (!state.defaultName && state.endpoints.length === 1) state.defaultName = name;
		await writeRegistry(state);
		return state;
	});
}

export async function removeEndpoint(name: string): Promise<RegistryState> {
	return withMutation(async () => {
		const state = await readRegistry();
		state.endpoints = state.endpoints.filter((e) => e.name !== name);
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
 *   4. Built-in fallback (http://localhost:3583)
 */
export async function resolveEndpoint(ref?: string): Promise<string> {
	if (ref && /^https?:\/\//.test(ref)) return ref.replace(/\/$/, '');

	const state = await readRegistry();

	if (ref) {
		const match = state.endpoints.find((e) => e.name === ref);
		if (match) return match.url.replace(/\/$/, '');
		throw new Error(`Endpoint "${ref}" not found in registry. Add it with add_endpoint.`);
	}

	if (state.defaultName) {
		const match = state.endpoints.find((e) => e.name === state.defaultName);
		if (match) return match.url.replace(/\/$/, '');
	}

	return 'http://localhost:3583';
}
