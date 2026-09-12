/**
 * The 13 tools of §9.2 in MCP_TOOL_NAMES order; `registerTools` wires them
 * into an McpServer with per-call context resolution and a crash guard.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCP_TOOL_NAMES } from '@relay/core';
import type { CallContext } from '../context.js';
import { toolResult } from '../format.js';
import { claimTool } from './claim.js';
import { decideTool } from './decide.js';
import { decisionsTool } from './decisions.js';
import type { AnyToolDef } from './define.js';
import { handoffTool } from './handoff.js';
import { handoffsTool } from './handoffs.js';
import { impactOfTool } from './impact-of.js';
import { impactsTool } from './impacts.js';
import { notifyTool } from './notify.js';
import { recentChangesTool } from './recent-changes.js';
import { releaseTool } from './release.js';
import { statusTool } from './status.js';
import { whoIsOnTool } from './who-is-on.js';
import { whoamiTool } from './whoami.js';

export const TOOLS: readonly AnyToolDef[] = [
  statusTool,
  whoIsOnTool,
  recentChangesTool,
  decisionsTool,
  notifyTool,
  claimTool,
  releaseTool,
  impactsTool,
  impactOfTool,
  handoffsTool,
  handoffTool,
  decideTool,
  whoamiTool,
] as unknown as AnyToolDef[];

/** Sanity: every name of MCP_TOOL_NAMES is registered exactly once. */
export function missingToolNames(): string[] {
  const names = new Set(TOOLS.map((t) => t.name));
  return MCP_TOOL_NAMES.filter((n) => !names.has(n));
}

export function registerTools(server: McpServer, contextFor: () => Promise<CallContext>): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema, annotations: tool.annotations },
      async (args): Promise<CallToolResult> => {
        try {
          const ctx = await contextFor();
          return await tool.handler(ctx, args as never);
        } catch (err) {
          // never throw to the client (§9.1); the message is factual and secret-free
          const message = err instanceof Error ? err.message : String(err);
          return toolResult(`Relay ${tool.name} failed locally: ${message}`, { error: 'internal', tool: tool.name, message }, { isError: true });
        }
      },
    );
  }
}
