#!/usr/bin/env node

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import sharp from "sharp";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { buildActor } = require("../../13th-age/src/scripts/custom-monster-builder.cjs");
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IMAGE_OUTPUT_DIR = path.resolve(SERVER_DIR, "..", "generated-images");
const DEFAULT_TOKEN_OUTPUT_DIR = path.resolve(SERVER_DIR, "..", "generated-tokens");

const HOST = process.env.FOUNDRY_LOCAL_MCP_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.FOUNDRY_LOCAL_MCP_PORT || "3001", 10);
const WS_PATH = process.env.FOUNDRY_LOCAL_MCP_WS_PATH || "/ws";
const HTTP_PORT = Number.parseInt(process.env.FOUNDRY_LOCAL_MCP_HTTP_PORT || "3002", 10);
const COMPANION_PORT = Number.parseInt(process.env.FOUNDRY_LOCAL_MCP_COMPANION_PORT || "3003", 10);
const COMPANION_WS_PATH = process.env.FOUNDRY_LOCAL_MCP_COMPANION_WS_PATH || "/ws";
const COMMAND_TIMEOUT_MS = Number.parseInt(process.env.FOUNDRY_LOCAL_MCP_TIMEOUT_MS || "30000", 10);
const A1111_URL = process.env.FOUNDRY_LOCAL_MCP_A1111_URL || "http://127.0.0.1:7860";
const POLLINATIONS_IMAGE_URL = process.env.FOUNDRY_LOCAL_MCP_POLLINATIONS_IMAGE_URL || "https://image.pollinations.ai";

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
      log(`Rejected duplicate Foundry connection from ${request.socket.remoteAddress}; keeping existing client`);
      socket.close(1008, "Another Foundry client is already connected");
      return;
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
      log(`Rejected duplicate companion connection from ${request.socket.remoteAddress}; keeping existing client`);
      socket.close(1008, "Another Foundry client is already connected");
      return;
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

    if (request.method === "POST" && url.pathname === "/token/stamp") {
      sendJson(response, 200, await stampTokenImageWorkflow(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/token/generate") {
      sendJson(response, 200, await generateTokenImageWorkflow(await readJsonBody(request)));
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
  let prototypeToken = null;

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

  if (isCompanionConnected()) {
    prototypeToken = await requireCompanionSuccess("set-actor-prototype-token", {
      actorId: createdActor.id,
      textureSrc: actor.prototypeToken?.texture?.src || actor.img,
      width: actor.prototypeToken?.width,
      height: actor.prototypeToken?.height,
      actorLink: actor.prototypeToken?.actorLink,
      disposition: actor.prototypeToken?.disposition,
      updateActorImg: true
    });
  }

  return {
    actor: createdActor,
    itemsCreated: createdItems.length,
    items: createdItems,
    prototypeToken,
    note: prototypeToken
      ? "Actor image and prototype token were applied through the companion module."
      : "Actor was created, but the companion module was not connected, so prototype token art was not applied."
  };
}

function sanitizeTokenFilename(value) {
  const safe = String(value || "token")
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  return `${safe || "token"}.png`;
}

function promptToFilename(prompt, fallback = "generated-token-source") {
  return sanitizeTokenFilename(
    String(prompt || fallback)
      .split(/\s+/)
      .slice(0, 8)
      .join("-")
  );
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}`);
  }
}

function imagePayloadToBuffer(imagePayload) {
  const raw = String(imagePayload || "");
  const base64 = raw.includes(",") ? raw.split(",").at(-1) : raw;
  if (!base64) throw new Error("Image provider returned an empty image payload");
  return Buffer.from(base64, "base64");
}

async function writeGeneratedSourceImage(params, buffer) {
  const tokenName = params.tokenName || params.prompt;
  const outputPath = path.resolve(
    params.sourceOutputPath || path.join(DEFAULT_IMAGE_OUTPUT_DIR, promptToFilename(tokenName))
  );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
  return outputPath;
}

function automatic1111Payload(params) {
  const payload = {
    prompt: params.prompt,
    negative_prompt: params.negativePrompt,
    width: Number(params.imageWidth ?? 768),
    height: Number(params.imageHeight ?? 768),
    steps: Number(params.steps ?? 24),
    cfg_scale: Number(params.cfgScale ?? 7),
    batch_size: 1,
    n_iter: 1,
    restore_faces: Boolean(params.restoreFaces ?? false)
  };

  if (params.seed !== undefined) payload.seed = Number(params.seed);
  if (params.samplerName) payload.sampler_name = params.samplerName;
  if (params.styles?.length) payload.styles = params.styles;

  return payload;
}

async function generateWithAutomatic1111(params) {
  const baseUrl = String(params.generatorUrl || A1111_URL).replace(/\/+$/, "");
  const data = await fetchJson(`${baseUrl}/sdapi/v1/txt2img`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(automatic1111Payload(params))
  });

  if (!Array.isArray(data.images) || !data.images[0]) {
    throw new Error("AUTOMATIC1111 did not return any images");
  }

  return {
    provider: "automatic1111",
    sourceImagePath: await writeGeneratedSourceImage(params, imagePayloadToBuffer(data.images[0])),
    info: data.info ? JSON.parse(data.info) : null
  };
}

async function generateWithPollinations(params) {
  const baseUrl = String(params.generatorUrl || POLLINATIONS_IMAGE_URL).replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/prompt/${encodeURIComponent(params.prompt)}`);

  url.searchParams.set("width", String(Number(params.imageWidth ?? 768)));
  url.searchParams.set("height", String(Number(params.imageHeight ?? 768)));
  url.searchParams.set("nologo", "true");
  url.searchParams.set("private", "true");
  if (params.seed !== undefined) url.searchParams.set("seed", String(Number(params.seed)));
  if (params.model) url.searchParams.set("model", params.model);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${(await response.text()).slice(0, 500)}`);
  }

  return {
    provider: "pollinations",
    sourceImagePath: await writeGeneratedSourceImage(params, Buffer.from(await response.arrayBuffer())),
    info: {
      url: url.toString()
    }
  };
}

async function generateSourceImage(params) {
  switch (params.provider ?? "automatic1111") {
    case "automatic1111":
      return await generateWithAutomatic1111(params);
    case "pollinations":
      return await generateWithPollinations(params);
    default:
      throw new Error(`Unknown image generation provider: ${params.provider}`);
  }
}

function generatedImageStampParams(params, sourceImagePath) {
  return {
    sourceImagePath,
    tokenName: params.tokenName || params.prompt,
    outputPath: params.outputPath,
    size: params.size,
    borderWidth: params.borderWidth,
    borderColor: params.borderColor,
    borderAccentColor: params.borderAccentColor,
    backgroundColor: params.backgroundColor,
    fit: params.fit,
    position: params.position,
    uploadToFoundry: params.uploadToFoundry,
    foundrySavePath: params.foundrySavePath,
    actorId: params.actorId,
    width: params.width,
    height: params.height,
    actorLink: params.actorLink,
    updateActorImg: params.updateActorImg,
    disposition: params.disposition
  };
}

async function generateTokenImageWorkflow(params) {
  const generated = await generateSourceImage(params);
  const stamped = await stampTokenImageWorkflow(generatedImageStampParams(params, generated.sourceImagePath));

  return {
    prompt: params.prompt,
    provider: generated.provider,
    sourceImagePath: generated.sourceImagePath,
    generationInfo: generated.info,
    ...stamped,
    note: stamped.uploaded
      ? "Image was generated, stamped, uploaded into Foundry, and optionally assigned to an actor."
      : "Image was generated and stamped locally. Pass uploadToFoundry or actorId to upload it into Foundry."
  };
}

function assertColor(value, fieldName) {
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) {
    throw new Error(`${fieldName} must be a #RRGGBB or #RRGGBBAA color`);
  }
}

function circleSvg(size, radius, fill = "white") {
  return Buffer.from(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="${fill}"/>` +
    "</svg>"
  );
}

function borderSvg(size, borderWidth, borderColor, borderAccentColor) {
  const center = size / 2;
  const radius = center - borderWidth / 2;
  const accentRadius = center - borderWidth - 2;

  return Buffer.from(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${borderColor}" stroke-width="${borderWidth}"/>` +
      `<circle cx="${center}" cy="${center}" r="${accentRadius}" fill="none" stroke="${borderAccentColor}" stroke-width="2" opacity="0.75"/>` +
    "</svg>"
  );
}

async function createStampedTokenImage(params) {
  const size = Number(params.size ?? 512);
  const borderWidth = Number(params.borderWidth ?? Math.max(16, Math.round(size * 0.055)));
  const borderColor = params.borderColor ?? "#4b3528";
  const borderAccentColor = params.borderAccentColor ?? "#d6c184";
  const backgroundColor = params.backgroundColor ?? "#00000000";
  const fit = params.fit ?? "cover";
  const position = params.position ?? "center";
  const tokenName = params.tokenName || path.basename(params.sourceImagePath, path.extname(params.sourceImagePath));
  const filename = sanitizeTokenFilename(tokenName);
  const outputPath = path.resolve(params.outputPath || path.join(DEFAULT_TOKEN_OUTPUT_DIR, filename));

  if (!Number.isInteger(size) || size < 128 || size > 2048) {
    throw new Error("size must be an integer between 128 and 2048");
  }
  if (!Number.isInteger(borderWidth) || borderWidth < 0 || borderWidth >= size / 3) {
    throw new Error("borderWidth must be an integer from 0 to less than one third of size");
  }
  assertColor(borderColor, "borderColor");
  assertColor(borderAccentColor, "borderAccentColor");
  assertColor(backgroundColor, "backgroundColor");

  const sourceImagePath = path.resolve(params.sourceImagePath);
  await fs.access(sourceImagePath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const innerRadius = size / 2 - borderWidth;
  const mask = circleSvg(size, innerRadius);
  const framedSubject = await sharp(sourceImagePath)
    .resize(size, size, { fit, position })
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();

  const output = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: backgroundColor
    }
  })
    .composite([
      { input: framedSubject },
      { input: borderSvg(size, borderWidth, borderColor, borderAccentColor) }
    ])
    .png()
    .toBuffer();

  await fs.writeFile(outputPath, output);

  return {
    localPath: outputPath,
    filename,
    size,
    borderWidth,
    buffer: output
  };
}

async function stampTokenImageWorkflow(params) {
  const stamped = await createStampedTokenImage(params);
  const shouldUpload = Boolean(params.uploadToFoundry || params.actorId);
  let uploaded = null;
  let prototypeToken = null;

  if (shouldUpload) {
    uploaded = await requireCompanionSuccess("upload-token-image", {
      dataUrl: `data:image/png;base64,${stamped.buffer.toString("base64")}`,
      filename: stamped.filename,
      savePath: params.foundrySavePath
    });
  }

  if (params.actorId) {
    prototypeToken = await requireCompanionSuccess("set-actor-prototype-token", {
      actorId: params.actorId,
      textureSrc: uploaded.path,
      width: params.width,
      height: params.height,
      actorLink: params.actorLink,
      disposition: params.disposition,
      updateActorImg: params.updateActorImg ?? true
    });
  }

  return {
    localPath: stamped.localPath,
    filename: stamped.filename,
    size: stamped.size,
    borderWidth: stamped.borderWidth,
    uploaded,
    prototypeToken,
    note: shouldUpload
      ? "Token image was uploaded through the Foundry Local Bridge companion module."
      : "Token image was stamped locally only. Pass uploadToFoundry or actorId to upload it into Foundry."
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
  disposition: tokenDispositionSchema,
  updateActorImg: z.boolean().optional()
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

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);

const stampTokenImageSchema = {
  sourceImagePath: z.string(),
  tokenName: z.string().optional(),
  outputPath: z.string().optional(),
  size: z.number().int().min(128).max(2048).default(512),
  borderWidth: z.number().int().min(0).optional(),
  borderColor: colorSchema.default("#4b3528"),
  borderAccentColor: colorSchema.default("#d6c184"),
  backgroundColor: colorSchema.default("#00000000"),
  fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).default("cover"),
  position: z.string().default("center"),
  uploadToFoundry: z.boolean().default(false),
  foundrySavePath: z.string().optional(),
  actorId: z.string().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  actorLink: z.boolean().optional(),
  updateActorImg: z.boolean().optional(),
  disposition: tokenDispositionSchema
};

const generateTokenImageSchema = {
  provider: z.enum(["automatic1111", "pollinations"]).default("automatic1111"),
  generatorUrl: z.string().url().optional(),
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  tokenName: z.string().optional(),
  sourceOutputPath: z.string().optional(),
  model: z.string().optional(),
  imageWidth: z.number().int().min(128).max(2048).default(768),
  imageHeight: z.number().int().min(128).max(2048).default(768),
  steps: z.number().int().min(1).max(150).default(24),
  cfgScale: z.number().positive().max(30).default(7),
  seed: z.number().int().optional(),
  samplerName: z.string().optional(),
  styles: z.array(z.string()).optional(),
  restoreFaces: z.boolean().optional(),
  outputPath: z.string().optional(),
  size: z.number().int().min(128).max(2048).default(512),
  borderWidth: z.number().int().min(0).optional(),
  borderColor: colorSchema.default("#4b3528"),
  borderAccentColor: colorSchema.default("#d6c184"),
  backgroundColor: colorSchema.default("#00000000"),
  fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).default("cover"),
  position: z.string().default("center"),
  uploadToFoundry: z.boolean().default(false),
  foundrySavePath: z.string().optional(),
  actorId: z.string().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  actorLink: z.boolean().optional(),
  updateActorImg: z.boolean().optional(),
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
  "foundry_stamp_token_image",
  {
    title: "Stamp and upload token image",
    description: "Turn a local image file, such as a Cursor-generated image, into a circular Foundry token PNG. Optionally upload it into Foundry and set an actor prototype token.",
    inputSchema: stampTokenImageSchema
  },
  async (params) => jsonContent(await stampTokenImageWorkflow(params))
);

server.registerTool(
  "foundry_generate_token_image",
  {
    title: "Generate, stamp, and upload token image",
    description: "Generate token art from a text prompt using a local AUTOMATIC1111-compatible API or Pollinations, stamp it into a circular token PNG, and optionally upload or assign it in Foundry.",
    inputSchema: generateTokenImageSchema
  },
  async (params) => jsonContent(await generateTokenImageWorkflow(params))
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
