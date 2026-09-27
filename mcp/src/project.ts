// Local project discovery: the agents a Flue project mounts in app.ts, so a
// fresh `vite dev` is reachable without registering anything. Shares the
// plugin's project helpers (bundled into dist at build time).

import { basename } from 'node:path';

import {
	discoverEntry,
	findFlueProjectRoot,
	readAppMounts,
	resolveSourceRoot,
} from '../../scripts/lib/flue-project.mjs';
import { DEFAULT_BASE_URL } from './constants.ts';

export interface ProjectAgent {
	/** Name usable as `agent`: the mount path's last segment (e.g. "support"). */
	name: string;
	/** Exported agent function mounted there (its identity unless agentName is pinned). */
	export: string;
	/** Mount path in app.ts, e.g. "/agents/support". */
	path: string;
	/** Mount URL against the base URL; null when the path has route params. */
	url: string | null;
}

export interface ProjectInfo {
	root: string;
	app: string | null;
	base_url: string;
	agents: ProjectAgent[];
	/** app.ts builds its routes from import.meta.glob — mounts can't be read statically. */
	uses_glob: boolean;
}

/** The project directory to inspect: an explicit argument, the host-provided env, or cwd. */
export function projectDirectory(explicit?: string): string {
	if (explicit) return explicit;
	const fromEnv = process.env.FLUE_LOOM_PROJECT_DIR;
	// An unexpanded "${CLAUDE_PROJECT_DIR}" means the host didn't substitute it.
	if (fromEnv && !fromEnv.includes('${')) return fromEnv;
	return process.cwd();
}

export function baseUrl(explicit?: string): string {
	return trimSlash(explicit || process.env.FLUE_LOOM_BASE_URL || DEFAULT_BASE_URL);
}

export function discoverProject(options: { projectDir?: string; baseUrl?: string } = {}): ProjectInfo | null {
	const root: string | undefined = findFlueProjectRoot(projectDirectory(options.projectDir));
	if (!root) return null;
	const base = baseUrl(options.baseUrl);
	const app: string | undefined = discoverEntry(resolveSourceRoot(root), 'app');
	const mounts = readAppMounts(app);
	const agents = mounts.agents.flatMap(({ path, agent }: { path?: string; agent?: string }) => {
		if (!path || !agent) return [];
		const clean = `/${path.replace(/^\/+|\/+$/g, '')}`;
		return [
			{
				name: basename(clean) || agent,
				export: agent,
				path: clean,
				url: /[:*]/.test(clean) ? null : `${base}${clean}`,
			},
		];
	});
	return { root, app: app ?? null, base_url: base, agents, uses_glob: mounts.usesGlob };
}

export function trimSlash(url: string): string {
	return url.replace(/\/+$/, '');
}
