/**
 * Tool definition shape shared by src/tools/*.ts: name, description (< 1 KB,
 * §9.1), zod input shape, MCP annotations and a handler that receives the
 * per-call context. Handlers return a CallToolResult and never throw (the
 * server wraps them anyway).
 */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolName } from '@relay/core';
import type { z } from 'zod';
import type { CallContext } from '../context.js';

export interface ToolDef<Shape extends z.ZodRawShape> {
  name: McpToolName;
  description: string;
  schema: Shape;
  annotations: ToolAnnotations;
  handler: (ctx: CallContext, args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

/** Erased form used by the registry. */
export type AnyToolDef = ToolDef<z.ZodRawShape>;

export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
