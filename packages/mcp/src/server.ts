/**
 * stdio entry of packages/plugin/dist/mcp.mjs (§2.3, §9.1): connect the Relay
 * server to stdin/stdout. Claude Code may spawn the server twice at startup
 * and sends SIGINT at teardown (experiment B.16), so startup is idempotent
 * (no files written) and the signals close the transport cleanly. Nothing
 * here writes to stdout except the MCP framing; diagnostics go to stderr
 * only with RELAY_DEBUG=1.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRelayServer } from './app.js';

const debug = process.env['RELAY_DEBUG'] === '1';
const log = (msg: string): void => {
  if (debug) process.stderr.write(`relay-mcp: ${msg}\n`);
};

const server = createRelayServer();
const transport = new StdioServerTransport();

let closing = false;
const shutdown = (why: string): void => {
  if (closing) return;
  closing = true;
  log(`closing (${why})`);
  void server.close().finally(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.stdin.on('end', () => shutdown('stdin closed'));
process.on('uncaughtException', (err) => log(`uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
process.on('unhandledRejection', (err) => log(`unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));

server
  .connect(transport)
  .then(() => log(`connected (pid ${process.pid}, ppid ${process.ppid}, cwd ${process.cwd()})`))
  .catch((err: unknown) => {
    log(`connect failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  });
