#!/usr/bin/env node
// flue-loom MCP server entrypoint. Stdio transport.
//
// Uses the modern McpServer + registerTool API (TypeScript SDK ≥ 1.6).
// All tool definitions live in tools/index.ts; this file just wires the
// server, registers the tools, and connects the stdio transport.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from './tools/index.ts';

const server = new McpServer({
	name: 'flue-loom-mcp-server',
	version: '0.1.0',
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
