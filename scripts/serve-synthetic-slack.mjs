#!/usr/bin/env node
/**
 * Serve the synthetic Slack-like page on 127.0.0.1 so the live CDP transport
 * can be exercised end to end with a local Chrome and no Slack credential:
 *
 *   node scripts/serve-synthetic-slack.mjs --port 8765 [--shape links|tree]
 *   chromium --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/jev-cu-chrome \
 *     http://127.0.0.1:8765/client/T0SYNTH/C0GENERAL
 *   node bin/jev-cu-browse.mjs --profile slack-local-synthetic --mode observe --cdp http://127.0.0.1:9222
 *
 * `--shape tree` renders the sidebar, composer, and send button the way the
 * real Slack client does (see test/fixtures/synthetic-slack.mjs), so a real
 * Chromium computes the same empty row names the profile must cope with.
 *
 * Nothing is stored: every request renders from the JSON fixture, and the
 * page's own script keeps posted messages in the DOM only.
 */
import { createServer } from "node:http";
import { loadSyntheticPage, renderHtml, SHAPES } from "../test/fixtures/synthetic-slack.mjs";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex > -1 ? Number(args[portIndex + 1]) : 8765;
const shapeIndex = args.indexOf("--shape");
const shape = shapeIndex > -1 ? args[shapeIndex + 1] : undefined;
if (!Number.isInteger(port) || port < 0 || port > 65535 || (shape !== undefined && !SHAPES.includes(shape))) {
  process.stderr.write("usage: serve-synthetic-slack.mjs [--port N] [--shape links|tree]\n");
  process.exit(2);
}

const page = loadSyntheticPage({ shape: /** @type {import("../test/fixtures/synthetic-slack.mjs").Shape|undefined} */ (shape) });
const home = `/client/${page.team}/${page.conversations[0]?.id ?? ""}`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/") {
    res.writeHead(302, { location: home });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(renderHtml(page, url.pathname));
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`synthetic slack page: http://127.0.0.1:${actualPort}${home}\n`);
});
