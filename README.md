# GetMyCert MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives
any MCP-compatible AI agent (Claude Desktop, Claude Code, Cursor, Windsurf,
Continue, Zed, etc.) live access to **13,072 IT certification practice
questions across 27 certifications** on
[GetMyCert.com](https://getmycert.com).

Pay-per-call via **x402 micropayments** (USDC on Base, no signup) — or use a
traditional prepaid API key.

## Tools exposed

| Tool | Description |
| --- | --- |
| `get_cert_questions` | Fetch 1-25 multiple-choice questions for a certification, optionally filtered by difficulty. |
| `list_certifications` | List all 27 available certifications and their question counts. |

### Covered certifications

AWS (SAA, SysOps, Developer, Cloud Practitioner, Solutions Architect Pro),
CompTIA (A+, Network+, Security+, CySA+, CASP+, PenTest+, Cloud+, Data+,
Linux+, Server+), Google Cloud (ACE, PCA), Azure (Fundamentals, Administrator,
Developer, Security), Cisco CCNA, Kubernetes CKAD, PMP, CISSP, CEH, ITIL 4.

---

## Install

### From npm (recommended)

```bash
npm install -g @getmycert/mcp-server
```

### From source

```bash
git clone https://github.com/getmycert/mcp-server.git
cd mcp-server
npm install
npm run build
```

The build emits an executable at `dist/index.js`.

---

## Configure

You need **one** of the two payment methods.

### Option 1 — x402 micropayments (recommended)

1. Generate a hot wallet private key:

   ```bash
   openssl rand -hex 32
   ```

2. Fund the wallet's Base-mainnet address with a few dollars of USDC. Each
   batch of questions costs ~$0.01.

3. Set `GETMYCERT_WALLET_PRIVATE_KEY=0x<your_key>` in your agent's MCP config
   (see snippets below).

### Option 2 — Prepaid API key

1. Get an API key at <https://getmycert.com/dashboard/api-keys>.
2. Set `GETMYCERT_API_KEY=<your_key>` in the MCP config.

If both are configured, the server prefers x402 and falls back to the API key
on failure.

All available env vars are documented in [`.env.example`](./.env.example).

---

## Add to your agent

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "getmycert": {
      "command": "npx",
      "args": ["-y", "@getmycert/mcp-server"],
      "env": {
        "GETMYCERT_WALLET_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE"
      }
    }
  }
}
```

Restart Claude Desktop. You should see the GetMyCert tools listed under the
hammer icon.

### Claude Code

Add to `~/.claude.json` (global) or `.claude.json` in your project:

```json
{
  "mcpServers": {
    "getmycert": {
      "command": "npx",
      "args": ["-y", "@getmycert/mcp-server"],
      "env": {
        "GETMYCERT_API_KEY": "gmc_live_..."
      }
    }
  }
}
```

Or one-liner:

```bash
claude mcp add getmycert -- npx -y @getmycert/mcp-server
```

### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "getmycert": {
      "command": "npx",
      "args": ["-y", "@getmycert/mcp-server"],
      "env": {
        "GETMYCERT_WALLET_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE"
      }
    }
  }
}
```

### Windsurf / Continue / Zed

These all use the same stdio-MCP shape. Point them at `npx -y
@getmycert/mcp-server` with the same `env` block.

### Local dev build

If you cloned from source, replace the `command`/`args` with your built path:

```json
{
  "mcpServers": {
    "getmycert": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": {
        "GETMYCERT_WALLET_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

---

## Usage examples

Once installed, your agent can call the tools directly. Example prompts:

> "Give me 5 hard CISSP practice questions."
>
> "Quiz me on AWS SAA — 10 medium-difficulty questions, hide answers until I respond."
>
> "List every CompTIA certification on GetMyCert with question counts."

---

## How x402 payment works

1. Agent calls `get_cert_questions`.
2. The MCP server hits `https://getmycert.com/api/v1/x402`.
3. Server replies `HTTP 402 Payment Required` with the cost (e.g. 10000
   micro-USDC = $0.01), recipient address, and USDC contract.
4. The MCP server signs an EIP-3009 `transferWithAuthorization` from the
   configured wallet and retries with `X-PAYMENT: <base64-payload>`.
5. The facilitator settles on-chain; GetMyCert returns the questions.

The `GETMYCERT_MAX_PAYMENT` env var caps how much any single call may charge
(default 100000 = $0.10).

---

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GETMYCERT_WALLET_PRIVATE_KEY` | one of | — | 32-byte hex private key for the Base wallet that pays the x402 endpoint. |
| `GETMYCERT_API_KEY` | one of | — | Prepaid API key fallback. |
| `GETMYCERT_RPC_URL` | no | `https://mainnet.base.org` | Base RPC endpoint. |
| `GETMYCERT_X402_URL` | no | `https://getmycert.com/api/v1/x402` | x402 endpoint override. |
| `GETMYCERT_API_URL` | no | Supabase edge function | API-key endpoint override. |
| `GETMYCERT_CERTS_URL` | no | `https://getmycert.com/api/v1/certifications` | Public catalog endpoint override. |
| `GETMYCERT_MAX_PAYMENT` | no | `100000` | Max micro-USDC any one call may pay. |

---

## Hosted / remote MCP

The package also exports `createServer()` so you can host it behind an HTTP
transport (SSE or Streamable HTTP) without modifying the tool code:

```ts
import { createServer } from "@getmycert/mcp-server";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const server = createServer();
// wire SSEServerTransport into your HTTP framework of choice
```

---

## Submit to registries

This server is designed to be listed on community MCP registries.

- **Smithery.ai**: <https://smithery.ai/new>
- **MCP.so**: <https://mcp.so/submit>
- **Awesome MCP Servers**: open a PR at
  <https://github.com/modelcontextprotocol/servers>
- **Anthropic MCP Directory**: <https://www.anthropic.com/mcp> (submit via
  the contact form)

---

## License

MIT — see [LICENSE](./LICENSE).
