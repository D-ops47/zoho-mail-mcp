const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
let REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  const resp = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: { refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' }
  });
  accessToken = resp.data.access_token;
  tokenExpiry = Date.now() + (resp.data.expires_in * 1000);
  return accessToken;
}

async function zohoGet(path, params = {}) {
  const token = await getAccessToken();
  const resp = await axios.get(`https://mail.zoho.com/api/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` }, params
  });
  return resp.data;
}

async function zohoGetBinary(path) {
  const token = await getAccessToken();
  const resp = await axios.get(`https://mail.zoho.com/api/${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` }, responseType: 'arraybuffer'
  });
  return resp.data;
}

// MCP endpoint
app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body;
  
  try {
    if (method === 'initialize') {
      return res.json({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'zoho-mail-mcp', version: '1.0.0' }
      }});
    }

    if (method === 'tools/list') {
      return res.json({ jsonrpc: '2.0', id, result: { tools: [
        { name: 'list_accounts', description: 'List all Zoho Mail accounts', inputSchema: { type: 'object', properties: {} } },
        { name: 'list_folders', description: 'List all mail folders for an account', inputSchema: { type: 'object', properties: { account_id: { type: 'string', description: 'Account ID' } }, required: ['account_id'] } },
        { name: 'list_emails', description: 'List emails in a folder', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, folder_id: { type: 'string' }, limit: { type: 'number', default: 50 }, start: { type: 'number', default: 0 } }, required: ['account_id', 'folder_id'] } },
        { name: 'search_emails', description: 'Search emails across all folders', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number', default: 50 } }, required: ['account_id', 'query'] } },
        { name: 'get_email', description: 'Get full content of a specific email including body', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, message_id: { type: 'string' } }, required: ['account_id', 'message_id'] } },
        { name: 'list_attachments', description: 'List attachments for an email', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, message_id: { type: 'string' } }, required: ['account_id', 'message_id'] } },
        { name: 'get_attachment', description: 'Download and read attachment content (PDF, Word, text, etc)', inputSchema: { type: 'object', properties: { account_id: { type: 'string' }, message_id: { type: 'string' }, attachment_id: { type: 'string' } }, required: ['account_id', 'message_id', 'attachment_id'] } }
      ]}});
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      let result;

      if (name === 'list_accounts') {
        const data = await zohoGet('accounts');
        result = JSON.stringify(data.data || data, null, 2);
      }
      else if (name === 'list_folders') {
        const data = await zohoGet(`accounts/${args.account_id}/folders`);
        result = JSON.stringify(data.data || data, null, 2);
      }
      else if (name === 'list_emails') {
        const data = await zohoGet(`accounts/${args.account_id}/messages/view`, {
          folderId: args.folder_id, limit: args.limit || 50, start: args.start || 0
        });
        result = JSON.stringify(data.data || data, null, 2);
      }
      else if (name === 'search_emails') {
        const data = await zohoGet(`accounts/${args.account_id}/messages/search`, {
          searchKey: args.query, limit: args.limit || 50
        });
        result = JSON.stringify(data.data || data, null, 2);
      }
      else if (name === 'get_email') {
        const data = await zohoGet(`accounts/${args.account_id}/messages/${args.message_id}/content`);
        result = JSON.stringify(data.data || data, null, 2);
      }
      else if (name === 'list_attachments') {
        const data = await zohoGet(`accounts/${args.account_id}/messages/${args.message_id}/attachments`);
        result = JSON.stringify(data.data || data, null, 2);
      }
      else if (name === 'get_attachment') {
        const buffer = await zohoGetBinary(`accounts/${args.account_id}/messages/${args.message_id}/attachments/${args.attachment_id}`);
        // Try PDF parsing
        try {
          const pdfParse = require('pdf-parse');
          const parsed = await pdfParse(Buffer.from(buffer));
          result = `PDF TEXT CONTENT:\n${parsed.text}`;
        } catch(e) {
          // Try mammoth for Word docs
          try {
            const mammoth = require('mammoth');
            const parsed = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
            result = `WORD DOC CONTENT:\n${parsed.value}`;
          } catch(e2) {
            // Return base64 for other file types
            result = `BINARY FILE (base64):\n${Buffer.from(buffer).toString('base64').substring(0, 5000)}`;
          }
        }
      }
      else {
        throw new Error(`Unknown tool: ${name}`);
      }

      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] } });
    }

    res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (err) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'zoho-mail-mcp' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zoho Mail MCP server running on port ${PORT}`));
