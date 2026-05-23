# Zoho Mail MCP Server — Full Setup SOP

**Purpose:** Connect Zoho Mail to Claude.ai (or any MCP-compatible AI agent) so the AI can read all emails, search them, and extract text from PDF and Word document attachments.

**Account:** Property Solutions Of TX — info@propertysolutionsoftx.org
**GitHub:** D-ops47
**Railway:** Linked to D-ops47 GitHub (Hobby plan)

---

## PART 1: ZOHO OAUTH APP SETUP

### Step 1: Create a Zoho Self Client OAuth App

1. Go to **https://api-console.zoho.com**
2. Log in with your Zoho account (info@propertysolutionsoftx.org)
3. Click **"Self Client"** from the application types
4. Click **"CREATE"**
5. Confirm the popup "Are you sure to enable self-client?" → click **OK**
6. Your app is created. Note down:
   - **Client ID:** `1000.DN5CKKFDXNP6W4T8KZQIXJ7GD0UTEI`
   - **Client Secret:** *(visible on the Secret tab — 42 characters starting with `378b79239b4eefb46050d1c0d54775063214d`)*

---

### Step 2: Generate an Authorization Code

1. On api-console.zoho.com, click the **"Generate Code"** tab
2. Fill in the following:
   - **Scope:** `ZohoMail.messages.ALL,ZohoMail.folders.ALL,ZohoMail.attachments.ALL,ZohoMail.accounts.READ,ZohoMail.search.READ`
   - **Time Duration:** `10 minutes`
   - **Scope Description:** `Zoho Mail access for Claude AI`
3. Click **CREATE**
4. Copy the authorization code immediately — it expires in 10 minutes

---

### Step 3: Exchange the Authorization Code for a Refresh Token

Run this as a curl command (or in any HTTP client):

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=1000.DN5CKKFDXNP6W4T8KZQIXJ7GD0UTEI" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=https://api-console.zoho.com/client/1000.DN5CKKFDXNP6W4T8KZQIXJ7GD0UTEI/generate-code" \
  -d "code=YOUR_AUTH_CODE"
```

**The response will contain:**
- `access_token` — short-lived (1 hour), used for API calls
- `refresh_token` — **never expires**, used to get new access tokens automatically

**Refresh token for this account:**
`1000.a08d3162128a72c22f77bc094d080292.2cc9bc9fd39d002e2b7a0674e6df59e3`

> **Important:** Store the refresh token securely. You never need to repeat Steps 2–3 unless you explicitly revoke the token in Zoho.

---

## PART 2: GITHUB REPO SETUP

### Step 4: Create the GitHub Repository

1. Go to **https://github.com/new** (logged in as D-ops47)
2. Repository name: `zoho-mail-mcp`
3. Set to **Public**
4. Click **Create repository**
5. Repo URL: **https://github.com/D-ops47/zoho-mail-mcp**

---

### Step 5: Create a GitHub Personal Access Token

1. Go to **https://github.com/settings/tokens/new**
2. Name: `zoho-mcp-deploy`
3. Check the **repo** scope (full repository access)
4. Set expiration to **No expiration** (or your preferred duration)
5. Click **Generate token** and copy the token immediately

> Note: PATs are only shown once. If you lose it, generate a new one at the same URL.

---

### Step 6: Push the 4 Required Files to the Repo

The repo requires exactly these 4 files:

---

#### `package.json`

```json
{
  "name": "zoho-mail-mcp",
  "version": "1.0.0",
  "description": "Zoho Mail MCP server for Claude.ai",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.18.0",
    "axios": "^1.6.0",
    "pdf-parse": "^1.1.1",
    "mammoth": "^1.6.0"
  }
}
```

---

#### `railway.json`

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node server.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

---

#### `nixpacks.toml`

```toml
[phases.setup]
nixPkgs = ["nodejs_20"]

[phases.install]
cmds = ["npm install"]

[start]
cmd = "node server.js"
```

---

#### `server.js`

```javascript
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// Zoho credentials (set as Railway environment variables)
const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

let accessToken = null;
let tokenExpiry = 0;

// Auto token refresh
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  const res = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN
    }
  });
  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  return accessToken;
}

async function zohoGet(url, params = {}) {
  const token = await getAccessToken();
  const res = await axios.get(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params
  });
  return res.data;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body;
  const ok  = (result) => res.json({ jsonrpc: '2.0', id, result });
  const err = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'zoho-mail-mcp', version: '1.0.0' }
      });
    }

    if (method === 'tools/list') {
      return ok({ tools: [
        { name: 'list_accounts', description: 'List all Zoho Mail accounts', inputSchema: { type: 'object', properties: {} } },
        { name: 'list_folders', description: 'List folders in a Zoho Mail account', inputSchema: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'] } },
        { name: 'list_emails', description: 'List emails in a folder', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, folderId: { type: 'string' }, limit: { type: 'number' }, start: { type: 'number' } }, required: ['accountId', 'folderId'] } },
        { name: 'search_emails', description: 'Search emails across all folders', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: ['accountId', 'query'] } },
        { name: 'get_email', description: 'Get full content of a specific email', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, messageId: { type: 'string' } }, required: ['accountId', 'messageId'] } },
        { name: 'list_attachments', description: 'List attachments on an email', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, messageId: { type: 'string' } }, required: ['accountId', 'messageId'] } },
        { name: 'get_attachment', description: 'Download and read an attachment (PDFs and Word docs extracted as text)', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, messageId: { type: 'string' }, attachmentId: { type: 'string' } }, required: ['accountId', 'messageId', 'attachmentId'] } }
      ]});
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;

      if (name === 'list_accounts') {
        const data = await zohoGet('https://mail.zoho.com/api/accounts');
        const accounts = (data.data || []).map(a => ({ id: a.accountId, email: a.emailAddress, name: a.displayName, primary: a.primaryAccount }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }] });
      }

      if (name === 'list_folders') {
        const data = await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/folders`);
        const folders = (data.data || []).map(f => ({ id: f.folderId, name: f.folderName, path: f.folderPath, unread: f.unreadCount, total: f.messageCount }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(folders, null, 2) }] });
      }

      if (name === 'list_emails') {
        const data = await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/messages/view`, { folderId: args.folderId, limit: args.limit || 20, start: args.start || 1 });
        const emails = (data.data || []).map(m => ({ id: m.messageId, subject: m.subject, from: m.fromAddress, to: m.toAddress, date: m.receivedTime, hasAttachment: m.hasAttachment, summary: m.summary }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] });
      }

      if (name === 'search_emails') {
        const data = await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/messages/search`, { searchKey: args.query, limit: args.limit || 20 });
        const emails = (data.data || []).map(m => ({ id: m.messageId, subject: m.subject, from: m.fromAddress, date: m.receivedTime, summary: m.summary }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] });
      }

      if (name === 'get_email') {
        const data = await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/messages/${args.messageId}/content`);
        return ok({ content: [{ type: 'text', text: JSON.stringify(data.data || data, null, 2) }] });
      }

      if (name === 'list_attachments') {
        const data = await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/messages/${args.messageId}/attachments`);
        const attachments = (data.data || []).map(a => ({ id: a.attachmentId, name: a.attachmentName, size: a.attachmentSize, contentType: a.attachmentType }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(attachments, null, 2) }] });
      }

      if (name === 'get_attachment') {
        const token = await getAccessToken();
        const url = `https://mail.zoho.com/api/accounts/${args.accountId}/messages/${args.messageId}/attachments/${args.attachmentId}`;
        const res2 = await axios.get(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` }, responseType: 'arraybuffer' });
        const contentType = res2.headers['content-type'] || '';
        const buffer = Buffer.from(res2.data);

        if (contentType.includes('pdf')) {
          try {
            const pdfParse = require('pdf-parse');
            const parsed = await pdfParse(buffer);
            return ok({ content: [{ type: 'text', text: `PDF Text Content:\n${parsed.text}` }] });
          } catch (e) { return ok({ content: [{ type: 'text', text: `PDF parse error: ${e.message}` }] }); }
        }

        if (contentType.includes('word') || contentType.includes('officedocument')) {
          try {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            return ok({ content: [{ type: 'text', text: `Document Text:\n${result.value}` }] });
          } catch (e) { return ok({ content: [{ type: 'text', text: `Word parse error: ${e.message}` }] }); }
        }

        if (contentType.includes('text')) return ok({ content: [{ type: 'text', text: buffer.toString('utf-8') }] });

        return ok({ content: [{ type: 'text', text: `Binary attachment, size: ${buffer.length} bytes, type: ${contentType}` }] });
      }

      return err(-32601, `Unknown tool: ${name}`);
    }

    if (method === 'notifications/initialized') return res.status(204).end();
    return err(-32601, `Method not found: ${method}`);

  } catch (e) {
    console.error('MCP error:', e.message);
    return err(-32603, e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zoho Mail MCP server running on port ${PORT}`));
```

---

## PART 3: RAILWAY DEPLOYMENT

### Step 7: Create a Railway Account and Project

1. Go to **https://railway.com**
2. Click **Login** → **Continue with GitHub** → authorize with D-ops47
3. Accept the Fair Use Policy
4. Upgrade to **Hobby plan** ($5/month) — required to deploy services

### Step 8: Create the Project

1. Click **New Project**
2. Select **Deploy from GitHub repo**
3. Select **D-ops47/zoho-mail-mcp**
4. Project created — name: **shimmering-reflection**, service: **zoho-mail-mcp**

**Project reference IDs:**

| Key | Value |
|-----|-------|
| Project ID | `f8b010b7-6948-45f3-a001-fbe9a1c68804` |
| Service ID | `c2d46757-9bf7-4e74-85ca-66fd3d2a9b97` |
| Environment ID | `b71f526e-c025-44cb-a326-5102f0d8bab5` |

---

### Step 9: Set Environment Variables

1. Click on **zoho-mail-mcp** service → **Variables** tab
2. Add these 3 variables:

| Variable | Value |
|----------|-------|
| `ZOHO_CLIENT_ID` | `1000.DN5CKKFDXNP6W4T8KZQIXJ7GD0UTEI` |
| `ZOHO_CLIENT_SECRET` | *(your secret from api-console.zoho.com — do not share publicly)* |
| `ZOHO_REFRESH_TOKEN` | `1000.a08d3162128a72c22f77bc094d080292.2cc9bc9fd39d002e2b7a0674e6df59e3` |

---

### Step 10: Generate Public Domain

1. Click **Settings** on the zoho-mail-mcp service
2. Scroll to **Networking → Public Networking**
3. Click **Generate Domain**
4. Domain assigned: **`zoho-mail-mcp-production-4814.up.railway.app`**

---

### Step 11: Deploy

1. Click the **Deploy** button
2. Wait ~2 minutes for the build
3. Confirm build logs show: **[1/1] Healthcheck succeeded!**
4. Service status: **ACTIVE / Online**

**Endpoints:**

| Endpoint | URL |
|----------|-----|
| Health check | `https://zoho-mail-mcp-production-4814.up.railway.app/health` |
| MCP endpoint | `https://zoho-mail-mcp-production-4814.up.railway.app/mcp` |

---

## PART 4: CONNECTING TO CLAUDE.AI

### Step 12: Add Custom Connector

1. Go to **https://claude.ai/customize/connectors**
2. Click **+** (top right of the Connectors panel)
3. Select **Add custom connector**
4. Fill in:
   - **Name:** `Zoho Mail`
   - **Remote MCP server URL:** `https://zoho-mail-mcp-production-4814.up.railway.app/mcp`
5. Click **Add**

### Step 13: Verify

The **Zoho Mail (CUSTOM)** connector should appear in the Web section with 7 tools:

- `list_accounts` — list all Zoho email accounts
- `list_folders` — browse folders (Inbox, Sent, etc.)
- `list_emails` — retrieve emails from any folder
- `search_emails` — search across all emails
- `get_email` — read full email content
- `list_attachments` — see attachments on an email
- `get_attachment` — extract text from PDFs and Word docs

Tool permissions default to **Needs approval**. Change to **Always allowed** if preferred.

---

## PART 5: CREDENTIALS REFERENCE

| Item | Value |
|------|-------|
| Zoho account | info@propertysolutionsoftx.org |
| Zoho Client ID | `1000.DN5CKKFDXNP6W4T8KZQIXJ7GD0UTEI` |
| Zoho Client Secret | *(see api-console.zoho.com — do not share publicly)* |
| Zoho Refresh Token | `1000.a08d3162128a72c22f77bc094d080292.2cc9bc9fd39d002e2b7a0674e6df59e3` |
| GitHub repo | https://github.com/D-ops47/zoho-mail-mcp |
| Railway project | shimmering-reflection |
| MCP server URL | https://zoho-mail-mcp-production-4814.up.railway.app/mcp |

---

## PART 6: MAINTENANCE

**Token refresh:** Automatic — the server handles this internally using the refresh token.

**If the refresh token stops working:** Go to api-console.zoho.com, generate a new auth code (Step 2), exchange it for a new refresh token (Step 3), update `ZOHO_REFRESH_TOKEN` in Railway. Railway auto-redeploys.

**To update server code:** Push changes to D-ops47/zoho-mail-mcp on GitHub. Railway auto-deploys on every push to main.

**If the Railway URL changes:** Update the MCP URL in Claude.ai connector settings (3-dot menu on the connector → Edit).

**Unused Railway services:** The Railway Agent also deployed Redis, PostgreSQL, and a storage bucket that are not needed. Delete them from the Railway project to avoid extra charges.
