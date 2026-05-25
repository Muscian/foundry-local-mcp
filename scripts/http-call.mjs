#!/usr/bin/env node

import fs from "node:fs/promises";

const BASE = process.env.FOUNDRY_LOCAL_MCP_HTTP_URL || "http://127.0.0.1:3002";

async function readBody(arg) {
  if (!arg) return {};
  if (arg.startsWith("@")) {
    return JSON.parse(await fs.readFile(arg.slice(1), "utf8"));
  }
  return JSON.parse(arg);
}

const [endpointArg, jsonArg] = process.argv.slice(2);
if (!endpointArg) {
  console.error("Usage: npm run http -- <endpoint> [@params.json | '{...json...}']");
  console.error("Examples:");
  console.error("  npm run http -- status");
  console.error("  npm run http -- token/stamp @params/william-stamp.json");
  console.error("  npm run http -- token/generate '{\"provider\":\"pollinations\",\"prompt\":\"...\",\"tokenName\":\"William\"}'");
  process.exit(1);
}

const endpoint = endpointArg.replace(/^\/+/, "");
const url = `${BASE}/${endpoint}`;
const readOnly = endpoint === "status" || endpoint === "world-info";

const response = await fetch(url, readOnly
  ? { method: "GET" }
  : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await readBody(jsonArg))
    });

const text = await response.text();
if (!response.ok) {
  console.error(text);
  process.exit(1);
}

console.log(text);
