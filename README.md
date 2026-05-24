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
- A Foundry API Bridge-compatible module in the world.
- The module's WebSocket URL set to:

```txt
ws://127.0.0.1:3001/ws
```

If the module requires an API key even for local use, use a placeholder value such as:

```txt
local-dev
```

- The companion module [`foundry-local-bridge`](https://github.com/Muscian/foundry-local-bridge), installed and enabled in the same world.
- The companion module's WebSocket URL set to:

```txt
ws://127.0.0.1:3003/ws
```

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

The debug HTTP endpoints mirror the same functionality and are useful for smoke tests before using Cursor tools.

## Notes

`archmage_create_npc` uses `src/scripts/custom-monster-builder.cjs`, so it follows the same Archmage/13th Age schema as the custom monster pipeline.

The current bridge command `create-actor` does not accept `prototypeToken`, so the actor portrait is set via `img`, but token prototype art may still need manual adjustment or a later dedicated tool.

The companion module provides that dedicated prototype/token path.

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
