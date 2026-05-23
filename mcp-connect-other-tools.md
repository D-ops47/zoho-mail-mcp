# Connecting the Zoho Mail MCP to Other AI Tools

**MCP Server URL:** `https://zoho-mail-mcp-production-4814.up.railway.app/mcp`

This document explains how to connect the Zoho Mail MCP server to AI tools and agents beyond Claude.ai. The server speaks standard JSON-RPC 2.0 over HTTP POST, so it works with any tool that supports remote MCP servers.

---

## What You Need (Same for All Tools)

| Item | Value |
|------|-------|
| MCP Endpoint | `https://zoho-mail-mcp-production-4814.up.railway.app/mcp` |
| Health Check | `https://zoho-mail-mcp-production-4814.up.railway.app/health` |
| Protocol | HTTP POST, JSON-RPC 2.0 |
| Auth required | None (auth is handled inside the server using stored Zoho credentials) |

---

## Option 1: Manus AI

Manus is an AI agent platform that supports MCP tool servers.

### Steps

1. Open **Manus** and go to your agent or workspace settings
2. Look for **"Tools"**, **"Integrations"**, or **"MCP Servers"** in the settings panel
3. Click **"Add MCP Server"** or **"Connect Tool"**
4. Enter the following:
   - **Server URL:** `https://zoho-mail-mcp-production-4814.up.railway.app/mcp`
   - **Name:** `Zoho Mail`
   - **Description:** `Read emails and attachments from Zoho Mail`
5. Save and confirm

> **Note:** Manus may call this feature "Custom Tools" or "External MCP" depending on the version. If you see a field asking for an OpenAPI spec instead, use the raw MCP endpoint directly — Manus supports both formats.

### Verify

Ask Manus: *"List my Zoho email accounts"* — it should call the `list_accounts` tool and return your account info.

---

## Option 2: Cursor (AI Code Editor)

Cursor supports MCP servers via its `.cursor/mcp.json` configuration file.

### Steps

1. In your project root (or globally at `~/.cursor/mcp.json`), create or edit the MCP config file:

```json
{
  "mcpServers": {
    "zoho-mail": {
      "url": "https://zoho-mail-mcp-production-4814.up.railway.app/mcp",
      "transport": "http"
    }
  }
}
```

2. Restart Cursor
3. Open the Cursor chat panel — the Zoho Mail tools should appear in the available tools list

### Verify

In Cursor chat, type: *"Use the zoho mail tool to list my email accounts"*

---

## Option 3: Windsurf (Codeium)

Windsurf supports MCP via its settings panel.

### Steps

1. Open Windsurf settings → **"AI" → "MCP Servers"**
2. Click **"Add Server"**
3. Fill in:
   - **Name:** `zoho-mail`
   - **URL:** `https://zoho-mail-mcp-production-4814.up.railway.app/mcp`
   - **Transport:** `http`
4. Click **Save** and reload Windsurf

---

## Option 4: OpenAI GPT / Custom GPTs (via Action)

OpenAI's custom GPTs support external APIs. Since the MCP server speaks JSON-RPC, you can expose it via a custom action.

### Steps

1. Go to **https://chat.openai.com** → **Explore GPTs** → **Create a GPT**
2. Click **"Configure"** → **"Add actions"**
3. Click **"Import from URL"** — if you have an OpenAPI spec, use that. Otherwise, manually define the schema:

```yaml
openapi: 3.0.0
info:
  title: Zoho Mail MCP
  version: 1.0.0
servers:
  - url: https://zoho-mail-mcp-production-4814.up.railway.app
paths:
  /mcp:
    post:
      operationId: callMcpTool
      summary: Call a Zoho Mail MCP tool
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                jsonrpc:
                  type: string
                  default: "2.0"
                method:
                  type: string
                params:
                  type: object
                id:
                  type: integer
      responses:
        '200':
          description: MCP response
```

4. Set authentication to **None** (the server handles its own auth)
5. Save the GPT

---

## Option 5: n8n (Workflow Automation)

n8n can call any HTTP endpoint, making it easy to use the MCP server in automated workflows.

### Steps

1. In n8n, add an **HTTP Request** node
2. Configure it:
   - **Method:** POST
   - **URL:** `https://zoho-mail-mcp-production-4814.up.railway.app/mcp`
   - **Body Type:** JSON
   - **Body:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "list_accounts",
    "arguments": {}
  },
  "id": 1
}
```
3. Connect this node to your workflow trigger (e.g., a scheduled trigger to check emails daily)

### Example: Search for emails containing a keyword

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search_emails",
    "arguments": {
      "accountId": "YOUR_ACCOUNT_ID",
      "query": "invoice",
      "limit": 10
    }
  },
  "id": 1
}
```

---

## Option 6: Make (formerly Integromat)

Similar to n8n — use the **HTTP module** to make POST requests to the MCP endpoint.

### Steps

1. Add an **HTTP → Make a request** module
2. Set:
   - **URL:** `https://zoho-mail-mcp-production-4814.up.railway.app/mcp`
   - **Method:** POST
   - **Headers:** `Content-Type: application/json`
   - **Body:** (same JSON-RPC format as the n8n example above)

---

## Option 7: Any Custom AI Agent (Generic)

If you are building your own AI agent or using a framework like LangChain, AutoGen, CrewAI, or similar:

### HTTP Request Format

All calls are standard HTTP POST to `/mcp`:

```
POST https://zoho-mail-mcp-production-4814.up.railway.app/mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "tools/list",
  "params": {},
  "id": 1
}
```

### Initialization Sequence

Every new session should start with:

```json
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "your-agent", "version": "1.0.0" }
  },
  "id": 1
}
```

Then send `notifications/initialized` (no response needed), then call `tools/list` to discover available tools.

### Available Tools Summary

| Tool | Required Args | What It Does |
|------|--------------|--------------|
| `list_accounts` | none | Returns all Zoho email accounts with IDs |
| `list_folders` | `accountId` | Returns all folders (Inbox, Sent, etc.) with IDs |
| `list_emails` | `accountId`, `folderId` | Returns emails in a folder (paginated) |
| `search_emails` | `accountId`, `query` | Searches all emails by keyword |
| `get_email` | `accountId`, `messageId` | Returns full email body and headers |
| `list_attachments` | `accountId`, `messageId` | Lists attachments on an email |
| `get_attachment` | `accountId`, `messageId`, `attachmentId` | Returns attachment content (PDFs/Word docs as extracted text) |

### Example Tool Call

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "list_emails",
    "arguments": {
      "accountId": "123456789",
      "folderId": "987654321",
      "limit": 20,
      "start": 1
    }
  },
  "id": 2
}
```

### Python Example (LangChain / Custom Agent)

```python
import requests

MCP_URL = "https://zoho-mail-mcp-production-4814.up.railway.app/mcp"

def call_mcp(method, params=None, call_id=1):
    payload = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params or {},
        "id": call_id
    }
    response = requests.post(MCP_URL, json=payload)
    return response.json()

# Initialize
call_mcp("initialize", {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "my-agent", "version": "1.0.0"}
})

# List tools
tools = call_mcp("tools/list")
print(tools)

# List accounts
accounts = call_mcp("tools/call", {"name": "list_accounts", "arguments": {}})
account_id = accounts["result"]["content"][0]["text"]  # parse JSON from text
print(account_id)
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Server returns 404 | Make sure you're POSTing to `/mcp` not `/` |
| Server returns 401 or auth error | The server manages its own Zoho auth — no token needed in your request headers |
| Tools return empty data | Call `list_accounts` first to get a valid `accountId`, then use it in subsequent calls |
| PDF/Word attachment returns binary message | The file may not be a recognized PDF or Word format — check the `contentType` field in `list_attachments` |
| Railway server goes to sleep | Railway Hobby plan services stay awake as long as they receive traffic. The first request after idle may take 2–3 seconds |
| Zoho token expired error | The server auto-refreshes tokens. If you see this, the refresh token may have been revoked — regenerate it following Part 1 of the SOP |
