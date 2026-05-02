#!/usr/bin/env node
// flue-loom MCP server entrypoint. Stdio transport.
//
// Uses the modern McpServer + registerTool API (TypeScript SDK ≥ 1.6).
// All tool definitions live in tools/index.ts; this file just wires the
// server, registers the tools, and connects the stdio transport.

import { homedir } from 'node:os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from './tools/index.ts';

const SERVER_NAME = 'flue-loom-mcp-server';
const SERVER_VERSION = '0.1.0';

const server = new McpServer({
	name: SERVER_NAME,
	version: SERVER_VERSION,
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

// Diagnostic line on stderr (stdout is reserved for the JSON-RPC stream).
// Lets users confirm the server started and see where the endpoint
// registry is persisted.
const registryHome = process.env.FLUE_LOOM_HOME ?? `${homedir()}/.config/flue-loom`;
console.error(`[${SERVER_NAME}] v${SERVER_VERSION} ready · registry: ${registryHome}/endpoints.json`);
