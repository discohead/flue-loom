#!/usr/bin/env node
// MCP server entrypoint (stdio). Tool definitions live in tools/index.ts.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from './tools/index.ts';

const SERVER_NAME = 'flue-loom-mcp-server';
const SERVER_VERSION = '0.1.0';

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
registerTools(server);

await server.connect(new StdioServerTransport());

// stdout is reserved for JSON-RPC; diagnostic on stderr.
const registryHome = process.env.FLUE_LOOM_HOME ?? join(homedir(), '.config', 'flue-loom');
console.error(`[${SERVER_NAME}] v${SERVER_VERSION} ready · registry: ${join(registryHome, 'endpoints.json')}`);
