#!/usr/bin/env node

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { buildActor } = require("../../src/scripts/custom-monster-builder.cjs");

const HOST = process.env.FOUNDRY_LOCAL_MCP_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.FOUNDRY_LOCAL_MCP_PORT || "3001", 10);
const WS_PATH = process.env.FOUNDRY_LOCAL_MCP_WS_PATH || "/ws";
const HTTP_PORT = Number.parseInt(process.env.FOUNDRY_LOCAL_MCP_HTTP_PORT || "3002", 10);
const COMPANION_PORT = Number.parseInt(process.env.FOUNDRY_LOCAL_MCP_COMPANION_PORT || "3003", 10);
const COMPANION_WS_PATH = process.env.FOUNDRY_LOCAL_MCP_COMPANION_WS_PATH || "/ws";
const COMMAND_TIMEOUT_MS = Number.parseInt(process.env.FOUNDRY_LOCAL_MCP_TIMEOUT_MS || "30000", 10);

let foundrySocket = null;
let foundryConnectedAt = null;
const pendingCommands = new Map();
let companionSocket = null;
let companionConnectedAt = null;
const pendingCompanionCommands = new Map();

function log(message, ...args) {
  // MCP stdio reserves stdout for protocol messages.
  console.error(`[foundry-local-mcp] ${message}`, ...args);
}

function jsonContent(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function textContent(text) {
  return { content: [{ type: "text", text }] };
}

function startWebSocketServer() {
  const wss = new WebSocketServer({ host: HOST, port: PORT, path: WS_PATH });

  wss.on("connection", (socket, request) => {
    if (foundrySocket && foundrySocket.readyState === WebSocket.OPEN) {
      foundrySocket.close(1012, "Replacing active Foundry connection");
    }

    foundrySocket = socket;
    foundryConnectedAt = new Date();
    log(`Foundry connected from ${request.socket.remoteAddress}`);

    socket.on("message", (rawMessage) => {
      let response;
      try {
        response = JSON.parse(rawMessage.toString());
      } catch (error) {
        log(`Ignoring invalid JSON response: ${error.message}`);
        return;
      }

      if (!response?.id || !pendingCommands.has(response.id)) {
        log(`Ignoring response with unknown id: ${response?.id ?? "(missing)"}`);
        return;
      }

      const pending = pendingCommands.get(response.id);
      pendingCommands.delete(response.id);
      clearTimeout(pending.timeout);
      pending.resolve(response);
    });

    socket.on("close", () => {
      if (foundrySocket === socket) {
        foundrySocket = null;
        foundryConnectedAt = null;
      }
      log("Foundry disconnected");
    });

    socket.on("error", (error) => {
      log(`Foundry WebSocket error: ${error.message}`);
    });
  });

  wss.on("listening", () => {
    log(`Listening for Foundry at ws://${HOST}:${PORT}${WS_PATH}`);
  });

  wss.on("error", (error) => {
    log(`WebSocket server error: ${error.message}`);
  });

  return wss;
}

function startCompanionWebSocketServer() {
  const wss = new WebSocketServer({ host: HOST, port: COMPANION_PORT, path: COMPANION_WS_PATH });

  wss.on("connection", (socket, request) => {
    if (companionSocket && companionSocket.readyState === WebSocket.OPEN) {
      companionSocket.close(1012, "Replacing active companion connection");
    }

    companionSocket = socket;
    companionConnectedAt = new Date();
    log(`Companion module connected from ${request.socket.remoteAddress}`);

    socket.on("message", (rawMessage) => {
      let response;
      try {
        response = JSON.parse(rawMessage.toString());
      } catch (error) {
        log(`Ignoring invalid companion JSON response: ${error.message}`);
        return;
      }

      if (!response?.id || !pendingCompanionCommands.has(response.id)) {
        log(`Ignoring companion response with unknown id: ${response?.id ?? "(missing)"}`);
        return;
      }

      const pending = pendingCompanionCommands.get(response.id);
      pendingCompanionCommands.delete(response.id);
      clearTimeout(pending.timeout);
      pending.resolve(response);
    });

    socket.on("close", () => {
      if (companionSocket === socket) {
        companionSocket = null;
        companionConnectedAt = null;
      }
      log("Companion module disconnected");
    });

    socket.on("error", (error) => {
      log(`Companion WebSocket error: ${error.message}`);
    });
  });

  wss.on("listening", () => {
    log(`Listening for companion module at ws://${HOST}:${COMPANION_PORT}${COMPANION_WS_PATH}`);
  });

  wss.on("error", (error) => {
    log(`Companion WebSocket server error: ${error.message}`);
  });

  return wss;
}

function statusPayload() {
  return {
    connected: isFoundryConnected(),
    connectedAt: foundryConnectedAt?.toISOString() ?? null,
    websocketUrl: `ws://${HOST}:${PORT}${WS_PATH}`,
    companionConnected: isCompanionConnected(),
    companionConnectedAt: companionConnectedAt?.toISOString() ?? null,
    companionWebsocketUrl: `ws://${HOST}:${COMPANION_PORT}${COMPANION_WS_PATH}`,
    httpUrl: `http://${HOST}:${HTTP_PORT}`,
    pendingCommands: pendingCommands.size,
    pendingCompanionCommands: pendingCompanionCommands.size
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8").trim();
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });

    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function handleHttpRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${HOST}:${HTTP_PORT}`);

  try {
    if (request.method === "GET" && url.pathname === "/status") {
      sendJson(response, 200, statusPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/world-info") {
      sendJson(response, 200, await requireSuccess("get-world-info", {}));
      return;
    }

    if (request.method === "POST" && url.pathname === "/command") {
      const body = await readJsonBody(request);
      if (!body.type) throw new Error("Missing command type");
      sendJson(response, 200, await requireSuccess(body.type, body.params ?? {}));
      return;
    }

    if (request.method === "POST" && url.pathname === "/companion-command") {
      const body = await readJsonBody(request);
      if (!body.type) throw new Error("Missing companion command type");
      sendJson(response, 200, await requireCompanionSuccess(body.type, body.params ?? {}));
      return;
    }

    if (request.method === "POST" && url.pathname === "/archmage/create") {
      sendJson(response, 200, await createArchmageActorInFoundry(await readJsonBody(request)));
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

function startHttpServer() {
  const httpServer = http.createServer((request, response) => {
    void handleHttpRequest(request, response);
  });

  httpServer.listen(HTTP_PORT, HOST, () => {
    log(`Listening for debug HTTP at http://${HOST}:${HTTP_PORT}`);
  });

  httpServer.on("error", (error) => {
    log(`HTTP server error: ${error.message}`);
  });

  return httpServer;
}

function isFoundryConnected() {
  return Boolean(foundrySocket && foundrySocket.readyState === WebSocket.OPEN);
}

function isCompanionConnected() {
  return Boolean(companionSocket && companionSocket.readyState === WebSocket.OPEN);
}

async function sendFoundryCommand(type, params = {}) {
  if (!isFoundryConnected()) {
    throw new Error(`Foundry is not connected. Open the world as GM and point the module to ws://${HOST}:${PORT}${WS_PATH}.`);
  }

  const id = randomUUID();
  const command = { id, type, params };

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Timed out waiting for Foundry response to ${type}`));
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(id, { resolve, reject, timeout });

    try {
      foundrySocket.send(JSON.stringify(command));
    } catch (error) {
      clearTimeout(timeout);
      pendingCommands.delete(id);
      reject(error);
    }
  });
}

async function requireSuccess(type, params = {}) {
  const response = await sendFoundryCommand(type, params);
  if (!response.success) {
    throw new Error(response.error || `Foundry command failed: ${type}`);
  }
  return response.data;
}

async function sendCompanionCommand(type, params = {}) {
  if (!isCompanionConnected()) {
    throw new Error(`Companion module is not connected. Install/enable cursor-local-foundry-bridge and point it to ws://${HOST}:${COMPANION_PORT}${COMPANION_WS_PATH}.`);
  }

  const id = randomUUID();
  const command = { id, type, params };

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCompanionCommands.delete(id);
      reject(new Error(`Timed out waiting for companion response to ${type}`));
    }, COMMAND_TIMEOUT_MS);

    pendingCompanionCommands.set(id, { resolve, reject, timeout });

    try {
      companionSocket.send(JSON.stringify(command));
    } catch (error) {
      clearTimeout(timeout);
      pendingCompanionCommands.delete(id);
      reject(error);
    }
  });
}

async function requireCompanionSuccess(type, params = {}) {
  const response = await sendCompanionCommand(type, params);
  if (!response.success) {
    throw new Error(response.error || `Companion command failed: ${type}`);
  }
  return response.data;
}

function actorCreatePayload(actor) {
  return {
    name: actor.name,
    type: actor.type,
    img: actor.img,
    system: actor.system
  };
}

async function createArchmageActorInFoundry(source) {
  const actor = buildActor(source);
  const createdActor = await requireSuccess("create-actor", actorCreatePayload(actor));
  const createdItems = [];

  for (const item of actor.items ?? []) {
    const createdItem = await requireSuccess("add-item-to-actor", {
      actorId: createdActor.id,
      name: item.name,
      type: item.type,
      img: item.img,
      system: item.system
    });
    createdItems.push(createdItem);
  }

  return {
    actor: createdActor,
    itemsCreated: createdItems.length,
    items: createdItems,
    note: "prototypeToken is generated by the builder but the current bridge create-actor command does not accept it. Set token art manually or place tokens with create-token."
  };
}

const attackSchema = z.object({
  name: z.string(),
  attack: z.string().optional(),
  attackBonus: z.number().optional(),
  defense: z.string().optional(),
  hit: z.string().optional(),
  damage: z.union([z.string(), z.number()]).optional(),
  miss: z.string().optional(),
  description: z.string().optional(),
  group: z.string().optional(),
  img: z.string().optional()
});

const textItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  text: z.string().optional(),
  group: z.string().optional(),
  img: z.string().optional()
});

const archmageNpcSchema = {
  name: z.string(),
  level: z.number().int().min(0).max(14).default(1),
  role: z.enum(["archer", "blocker", "caster", "leader", "mook", "spoiler", "troop", "wrecker"]).default("troop"),
  type: z.enum([
    "aberration",
    "beast",
    "celestial",
    "construct",
    "demon",
    "devil",
    "dragon",
    "elemental",
    "fey",
    "giant",
    "humanoid",
    "monstrosity",
    "ooze",
    "plant",
    "spirit",
    "undead"
  ]).default("humanoid"),
  size: z.enum(["tiny", "small", "normal", "large", "huge", "gargantuan"]).default("normal"),
  strength: z.enum(["normal", "double", "triple", "weakling", "elite", "mook"]).default("normal"),
  img: z.string().optional(),
  token: z.union([z.string(), z.object({ img: z.string() })]).optional(),
  ac: z.number().optional(),
  pd: z.number().optional(),
  md: z.number().optional(),
  hp: z.number().optional(),
  initiative: z.number().optional(),
  flavor: z.string().optional(),
  resistance: z.string().optional(),
  vulnerability: z.string().optional(),
  source: z.string().default("Custom"),
  attacks: z.array(attackSchema).optional(),
  actions: z.array(attackSchema).optional(),
  traits: z.array(textItemSchema).optional(),
  nastierSpecials: z.array(textItemSchema).optional()
};

const tokenDispositionSchema = z.number().int().min(-2).max(1).optional();

const setActorPrototypeTokenSchema = {
  actorId: z.string(),
  width: z.number().positive().default(1),
  height: z.number().positive().optional(),
  textureSrc: z.string().optional(),
  actorLink: z.boolean().optional(),
  disposition: tokenDispositionSchema
};

const updateTokenFromActorSchema = {
  sceneId: z.string().optional(),
  tokenId: z.string(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  textureSrc: z.string().optional(),
  scale: z.number().positive().optional()
};

const createTokenFromActorSchema = {
  sceneId: z.string().optional(),
  actorId: z.string(),
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  textureSrc: z.string().optional(),
  name: z.string().optional(),
  hidden: z.boolean().optional(),
  elevation: z.number().optional(),
  rotation: z.number().optional(),
  disposition: tokenDispositionSchema
};

const server = new McpServer({
  name: "foundry-local-mcp",
  version: "0.1.0"
});

server.registerTool(
  "foundry_status",
  {
    title: "Foundry connection status",
    description: "Report whether the local Foundry WebSocket module is connected.",
    inputSchema: {}
  },
  async () => jsonContent({
    ...statusPayload()
  })
);

server.registerTool(
  "foundry_world_info",
  {
    title: "Foundry world info",
    description: "Ask the connected Foundry world for world metadata and content counts.",
    inputSchema: {}
  },
  async () => jsonContent(await requireSuccess("get-world-info", {}))
);

server.registerTool(
  "foundry_command",
  {
    title: "Raw Foundry bridge command",
    description: "Send a raw command to the Foundry API Bridge-compatible module. Use carefully.",
    inputSchema: {
      type: z.string(),
      params: z.record(z.string(), z.unknown()).default({})
    }
  },
  async ({ type, params }) => jsonContent(await requireSuccess(type, params))
);

server.registerTool(
  "foundry_companion_command",
  {
    title: "Raw companion module command",
    description: "Send a raw command to the local companion Foundry module for token/prototype operations.",
    inputSchema: {
      type: z.string(),
      params: z.record(z.string(), z.unknown()).default({})
    }
  },
  async ({ type, params }) => jsonContent(await requireCompanionSuccess(type, params))
);

server.registerTool(
  "archmage_build_npc",
  {
    title: "Build Archmage NPC JSON",
    description: "Build a Foundry-ready Archmage/13th Age NPC actor JSON locally without creating it in Foundry.",
    inputSchema: archmageNpcSchema
  },
  async (source) => jsonContent(buildActor(source))
);

server.registerTool(
  "archmage_create_npc",
  {
    title: "Create Archmage NPC in Foundry",
    description: "Build an Archmage/13th Age NPC actor and create it in the connected Foundry world, including action/trait/nastierSpecial items.",
    inputSchema: archmageNpcSchema
  },
  async (source) => jsonContent(await createArchmageActorInFoundry(source))
);

server.registerTool(
  "foundry_set_actor_prototype_token",
  {
    title: "Set actor prototype token",
    description: "Set an actor prototype token texture, dimensions, link state, and disposition via the local companion Foundry module.",
    inputSchema: setActorPrototypeTokenSchema
  },
  async (params) => jsonContent(await requireCompanionSuccess("set-actor-prototype-token", params))
);

server.registerTool(
  "foundry_update_token_from_actor",
  {
    title: "Update token from actor image",
    description: "Update an existing scene token so its texture uses its actor image or an explicit texture path, optionally setting dimensions.",
    inputSchema: updateTokenFromActorSchema
  },
  async (params) => jsonContent(await requireCompanionSuccess("update-token-from-actor", params))
);

server.registerTool(
  "foundry_create_token_from_actor",
  {
    title: "Create token from actor image",
    description: "Create a scene token using the actor image/prototype token image and explicit dimensions.",
    inputSchema: createTokenFromActorSchema
  },
  async (params) => jsonContent(await requireCompanionSuccess("create-token-from-actor", params))
);

server.registerTool(
  "foundry_setup_instructions",
  {
    title: "Foundry module setup instructions",
    description: "Return concise setup instructions for connecting Foundry to this local bridge.",
    inputSchema: {}
  },
  async () => textContent([
    "1. Open the hosted Foundry world as GM in this same machine/browser.",
    "2. Install or enable a Foundry API Bridge-compatible module.",
    `3. Set its WebSocket URL to ws://${HOST}:${PORT}${WS_PATH}.`,
    "4. If the module requires an API key, use any placeholder such as local-dev.",
    "5. Install/enable the companion module foundry-local-bridge.",
    `6. Set the companion module WebSocket URL to ws://${HOST}:${COMPANION_PORT}${COMPANION_WS_PATH}.`,
    "7. Save settings and reload the world.",
    "8. Call foundry_status, then foundry_world_info from Cursor."
  ].join("\n"))
);

startWebSocketServer();
startCompanionWebSocketServer();
startHttpServer();

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP stdio server ready");
