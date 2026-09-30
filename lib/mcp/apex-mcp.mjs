#!/usr/bin/env node
/* Apex MCP bridge. The agent CLIs (claude / codex) start this over stdio; it
 * exposes the tools the current agent may use and forwards every call to the
 * Apex server's internal API, which runs it and streams trace events to the
 * browser. Configured entirely through env set by the server:
 *   APEX_BASE_URL, APEX_TOKEN, APEX_RUN */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { request as httpRequest } from "node:http";

const BASE = process.env.APEX_BASE_URL || "http://127.0.0.1:3000";
const headers = {
  "content-type": "application/json",
  "x-apex-token": process.env.APEX_TOKEN || "",
  "x-apex-run": process.env.APEX_RUN || "",
};

/* node:http instead of fetch: a delegated job can take many minutes, and
 * fetch gives up waiting for response headers after 5. The CLI's own tool
 * timeout and the server's run budget bound the wait instead. */
function api(method, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${BASE}/api/internal/tools`, { method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`Apex API ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

const server = new Server({ name: "apex", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await api("GET");
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const { text, isError } = await api("POST", { name: req.params.name, arguments: req.params.arguments ?? {} });
    return { content: [{ type: "text", text }], isError: !!isError };
  } catch (e) {
    return { content: [{ type: "text", text: String(e?.message || e) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
