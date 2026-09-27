import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/server.ts'],
	format: ['esm'],
	platform: 'node',
	target: 'node22',
	clean: true,
	dts: false,
	outDir: 'dist',
	shims: true,
	// Self-contained output: dist/server.mjs must run straight from a plugin
	// install or an MCPB bundle, where mcp/node_modules doesn't exist. Every
	// runtime dependency is a devDependency and gets inlined here.
	deps: { alwaysBundle: [/^@modelcontextprotocol\//, /^zod(\/|$)/, /^@flue\/sdk$/, /^@durable-streams\//, /^@microsoft\//] },
});
