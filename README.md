# Foundry Local MCP

Local MCP bridge for Foundry VTT.

It is designed for AI clients that support the [Model Context Protocol](https://modelcontextprotocol.io/), including Cursor and other MCP-capable tools.

This avoids the paid hosted `foundry-mcp.com` write tier by keeping the write path on your own machine:

```txt
MCP-capable AI client
-> this local Node process
-> ws://127.0.0.1:3001/ws
-> Foundry API Bridge-compatible module running in your GM browser tab
-> your hosted Foundry world
```

For token/prototype operations that Foundry API Bridge does not expose, use the companion Foundry module [`foundry-local-bridge`](https://github.com/Muscian/foundry-local-bridge):

```txt
MCP-capable AI client
-> this local Node process
-> ws://127.0.0.1:3003/ws
-> Foundry Local Bridge companion module
-> your hosted Foundry world
```

## Requirements

- Cursor running on the same machine where you open Foundry in the browser.
- Your Foundry world open as GM.
- A Foundry API Bridge-compatible module in the world. This handles general world commands such as actor CRUD, item CRUD, scene queries, token placement, dice, combat, and journals.
- The Foundry API Bridge-compatible module's WebSocket URL set to:

```txt
ws://127.0.0.1:3001/ws
```

If the module requires an API key even for local use, use a placeholder value such as:

```txt
local-dev
```

- The companion module [`foundry-local-bridge`](https://github.com/Muscian/foundry-local-bridge), installed and enabled in the same world. This handles prototype-token and token texture/dimension commands that generic bridge modules often do not expose.
- The companion module's WebSocket URL set to:

```txt
ws://127.0.0.1:3003/ws
```

## Do I Need Both Foundry Modules?

For the full feature set, yes:

- **Foundry API Bridge-compatible module** on `ws://127.0.0.1:3001/ws`: general Foundry automation.
- **Foundry Local Bridge** on `ws://127.0.0.1:3003/ws`: prototype token and token image/size operations.

If you only need token/prototype operations, `foundry-local-bridge` can work by itself. If you only need the generic commands exposed by your existing bridge module, the companion module is optional.

## Install

```powershell
git clone https://github.com/Muscian/foundry-local-mcp.git
cd foundry-local-mcp
npm install
```

## Run Manually

```powershell
npm start
```

The server logs to stderr so stdout remains reserved for MCP.

For debug/testing from a terminal, the same process also exposes:

```txt
GET  http://127.0.0.1:3002/status
GET  http://127.0.0.1:3002/world-info
POST http://127.0.0.1:3002/command
POST http://127.0.0.1:3002/companion-command
POST http://127.0.0.1:3002/archmage/create
POST http://127.0.0.1:3002/token/stamp
POST http://127.0.0.1:3002/token/generate
```

## MCP Client Config

For Cursor, add this server to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "foundry-local": {
      "command": "node",
      "args": [
        "C:\\\\path\\\\to\\\\foundry-local-mcp\\\\src\\\\server.mjs"
      ],
      "env": {
        "FOUNDRY_LOCAL_MCP_HOST": "127.0.0.1",
        "FOUNDRY_LOCAL_MCP_PORT": "3001",
        "FOUNDRY_LOCAL_MCP_COMPANION_PORT": "3003"
      }
    }
  }
}
```

## Tools

- `foundry_status`: check whether Foundry is connected to the local WebSocket.
- `foundry_setup_instructions`: show the module setup checklist.
- `foundry_world_info`: ask Foundry for world metadata.
- `foundry_command`: send a raw bridge command.
- `foundry_companion_command`: send a raw companion module command.
- `archmage_build_npc`: build Archmage NPC JSON locally without creating it.
- `archmage_create_npc`: create an Archmage NPC and embedded action/trait/nastierSpecial items in Foundry.
- `foundry_set_actor_prototype_token`: set prototype token image/dimensions.
- `foundry_update_token_from_actor`: update an existing token to use its actor image.
- `foundry_create_token_from_actor`: create a token using actor/prototype token art and explicit dimensions.
- `foundry_stamp_token_image`: turn a local image file, such as a Cursor-generated image, into a circular token PNG. It can upload the PNG into Foundry through the companion module and assign it to an actor prototype token.
- `foundry_generate_token_image`: generate image art from a prompt, stamp it into a circular token PNG, and optionally upload or assign it in Foundry.

The debug HTTP endpoints mirror the same functionality and are useful for smoke tests before using Cursor tools.

## Notes

`archmage_create_npc` uses `src/scripts/custom-monster-builder.cjs`, so it follows the same Archmage/13th Age schema as the custom monster pipeline.

The generic bridge command `create-actor` does not accept `prototypeToken`, so `archmage_create_npc` creates the actor through the generic bridge and then applies actor/prototype token art through the `foundry-local-bridge` companion module when it is connected.

If token upload or actor image assignment fails with `Unknown companion command: upload-token-image`, Foundry is still running an older companion module. Update/reinstall `foundry-local-bridge` and reload the world as GM.

## Cursor Text-To-Token Workflow

Use this flow when you want Cursor to produce token art and place it in Foundry.

### Full Prompt-To-Token

The fully automated path uses `foundry_generate_token_image`.

For local free generation, run AUTOMATIC1111 Stable Diffusion WebUI with its API enabled:

```powershell
webui-user.bat --api
```

By default this MCP server calls:

```txt
http://127.0.0.1:7860/sdapi/v1/txt2img
```

Override it with `FOUNDRY_LOCAL_MCP_A1111_URL` or by passing `generatorUrl`.

Example:

```json
{
  "provider": "automatic1111",
  "prompt": "dark fantasy portrait token art, gaunt drowned noble wraith, pale blue witchfire eyes, tattered festival finery, centered bust, transparent background feeling, high detail",
  "negativePrompt": "text, watermark, logo, frame, border, blurry, extra faces",
  "tokenName": "Drowned Noble Wraith",
  "actorId": "abc123",
  "imageWidth": 768,
  "imageHeight": 768,
  "size": 512,
  "width": 1,
  "height": 1,
  "foundrySavePath": "worlds/my-world/tokens"
}
```

There is also a `pollinations` provider for quick free public-web experiments:

```json
{
  "provider": "pollinations",
  "prompt": "dark fantasy goblin lantern bearer, centered portrait, token art",
  "tokenName": "Goblin Lantern Bearer",
  "uploadToFoundry": true
}
```

Use local AUTOMATIC1111 for private campaign prep and reliable repeatability. Use `pollinations` only for throwaway tests or when you accept sending the prompt to a public service.

### Stamp Existing Art

If Cursor or another tool has already produced a local image file, use `foundry_stamp_token_image`.

1. Ask Cursor to generate a square creature or NPC image.
2. Call `foundry_stamp_token_image` with the generated image path.
3. Pass `actorId` to upload the stamped PNG into Foundry and set that actor's prototype token, or pass `uploadToFoundry: true` to only upload the asset.

Example:

```json
{
  "sourceImagePath": "C:\\Users\\ldmus\\Downloads\\velisse-wraith.png",
  "tokenName": "Velisse Wraith",
  "actorId": "abc123",
  "size": 512,
  "width": 1,
  "height": 1,
  "borderColor": "#4b3528",
  "borderAccentColor": "#d6c184",
  "foundrySavePath": "worlds/my-world/tokens"
}
```

If `actorId` is present, the tool uploads automatically. Without `actorId`, set `uploadToFoundry` to `true` if you only want the file copied into Foundry's Data storage. If `foundrySavePath` is omitted, the companion module saves to `worlds/<world-id>/tokens`.

## Installing the Companion Module on FoundryServer

Install [`foundry-local-bridge`](https://github.com/Muscian/foundry-local-bridge) using its manifest URL:

```text
https://raw.githubusercontent.com/Muscian/foundry-local-bridge/main/module.json
```

Then:

1. Enable `Foundry Local Bridge` in your world.
2. Open your world as GM from the same machine where this MCP server is running.
3. In module settings, set:

```txt
ws://127.0.0.1:3003/ws
```

4. Reload the world.
5. Run `foundry_status`; both `connected` and `companionConnected` should be `true`.

## Related Repositories

- [`foundry-local-bridge`](https://github.com/Muscian/foundry-local-bridge): Foundry VTT companion module.
- [`foundry-local-mcp`](https://github.com/Muscian/foundry-local-mcp): local MCP server and WebSocket relay.

## License

MIT
