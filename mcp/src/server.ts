#!/usr/bin/env node
// flue-loom MCP server (stdio): talk to Flue 2 agents over their conversation
// URLs from any MCP host. Tool definitions live in tools/index.ts.

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { SERVER_NAME, SERVER_VERSION } from './constants.ts';
import { registryPath } from './registry.ts';
import { registerTools } from './tools/index.ts';

// serveStdio answers both the 2025-era `initialize` handshake and the
// 2026-07-28 `server/discover` opening, so older and newer hosts both connect.
serveStdio(() => {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			instructions:
				'Talk to Flue 2 agents. An agent lives at its app.ts mount URL; a conversation is that URL plus an id. Start with flue_list_agents, then flue_send_message (reuse the returned conversation_id to continue). Use flue_read_reply for "pending" results, flue_get_conversation to inspect a transcript, and flue_abort to stop running work.',
		},
	);
	registerTools(server);
	return server;
});

// stdout carries JSON-RPC; diagnostics go to stderr.
console.error(`[${SERVER_NAME}] v${SERVER_VERSION} ready · registry: ${registryPath()}`);
