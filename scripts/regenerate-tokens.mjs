import fs from "node:fs/promises";

const BASE = "http://127.0.0.1:3002";
const jobs = JSON.parse(await fs.readFile(new URL("../params/regenerate-tokens.json", import.meta.url), "utf8"));

async function generate(job) {
  const response = await fetch(`${BASE}/token/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "pollinations",
      prompt: job.prompt,
      negativePrompt: job.negativePrompt,
      tokenName: job.tokenName,
      actorId: job.actorId,
      imageWidth: 768,
      imageHeight: 768,
      size: 512,
      width: 1,
      height: 1,
      updateActorImg: true,
      disposition: -1
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${job.name}: ${text}`);
  return JSON.parse(text);
}

const results = [];
for (const job of jobs) {
  console.log(`Generating ${job.name}...`);
  const result = await generate(job);
  results.push({
    name: job.name,
    actorId: job.actorId,
    borderWidth: result.borderWidth,
    localPath: result.localPath,
    uploaded: result.uploaded?.path ?? null,
    prototypeToken: result.prototypeToken ?? null,
    note: result.note
  });
}

console.log(JSON.stringify(results, null, 2));
