#!/usr/bin/env node
// flue-loom MCP server entrypoint. Stdio transport.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { tools } from './tools/index.ts';

const server = new Server(
	{
		name: 'flue-loom',
		version: '0.1.0',
	},
	{
		capabilities: {
			tools: {},
		},
	},
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
	})),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const tool = tools.find((t) => t.name === request.params.name);
	if (!tool) {
		throw new Error(`Unknown tool: ${request.params.name}`);
	}
	try {
		return await tool.call(request.params.arguments);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: 'text', text: `Error: ${message}` }],
			isError: true,
		};
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Stay alive until stdin closes.
process.stdin.resume();
