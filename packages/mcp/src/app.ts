/**
 * The Relay MCP server (§9.1): `McpServer` named `relay` with the factual
 * instructions string (<= 500 chars), the 13 tools of §9.2, and per-call
 * context resolution (live session from current/<ppid>.json, identity,
 * repo, cached snapshot, HubClient with the 5 s budget). Transport-agnostic
 * so tests can connect it over InMemoryTransport; src/server.ts wires stdio.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildContext, type CallContext, type ServerOptions } from './context.js';
import { registerTools } from './tools/index.js';

export const SERVER_NAME = 'relay';
export const SERVER_VERSION = '0.1.0';

/** §9.1 instructions, verbatim (factual, <= 500 chars). */
export const INSTRUCTIONS =
  "Relay tools report teammates' live sessions, contract changes and handoffs for this project. decide(text) records an architectural decision that appears in teammates' digests; impact_of(path) lists the dependents of a contract file before it is changed; notify(dev, message) reaches a teammate at their next prompt; handoff(summary) stores a session summary.";

export function createRelayServer(opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });
  const contextFor = (): Promise<CallContext> => buildContext(opts);
  registerTools(server, contextFor);
  return server;
}
