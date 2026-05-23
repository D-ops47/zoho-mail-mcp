const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  const res = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: { grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN }
  });
  if (!res.data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(res.data));
  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  console.log('Token refreshed, expires in', res.data.expires_in, 'seconds');
  return accessToken;
}

async function zohoGet(url, params = {}) {
  const token = await getAccessToken();
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params
    });
    return res.data;
  } catch(e) {
    const zohoErr = e.response?.data;
    const status = e.response?.status;
    throw new Error(`Zoho API ${status}: ${JSON.stringify(zohoErr || e.message)}`);
  }
}

// Unwrap Zoho response - handles {status:{},data:[]} and flat arrays
function unwrap(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (data.data) return [data.data];
  return [data];
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'zoho-mail-mcp' }));

app.get('/debug', async (req, res) => {
  try {
    const token = await getAccessToken();
    const acctRes = await axios.get('https://mail.zoho.com/api/accounts', {
      headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const accounts = unwrap(acctRes.data);
    const accountId = accounts[0]?.accountId;
    let folderTest = null;
    try {
      const fRes = await axios.get(`https://mail.zoho.com/api/accounts/${accountId}/folders`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` }
      });
      const folders = unwrap(fRes.data);
      folderTest = { status: fRes.status, count: folders.length, sample: folders.slice(0,3).map(f=>f.folderName) };
    } catch(fe) {
      folderTest = { error: fe.response?.status, body: JSON.stringify(fe.response?.data).substring(0,300) };
    }
    res.json({ tokenOk: true, accountId, accountEmail: accounts[0]?.primaryEmailAddress, folderTest });
  } catch(e) { res.json({ error: e.message }); }
});

app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body;
  const ok  = (result) => res.json({ jsonrpc: '2.0', id, result });
  const err = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      return ok({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'zoho-mail-mcp', version: '1.0.0' } });
    }

    if (method === 'tools/list') {
      return ok({ tools: [
        { name: 'list_accounts', description: 'List all Zoho Mail accounts', inputSchema: { type: 'object', properties: {} } },
        { name: 'list_folders', description: 'List folders in a Zoho Mail account', inputSchema: { type: 'object', properties: { accountId: { type: 'string' } }, required: ['accountId'] } },
        { name: 'list_emails', description: 'List emails in a folder (use list_folders first to get folderId)', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, folderId: { type: 'string' }, limit: { type: 'number', description: 'Default 20, max 200' }, start: { type: 'number', description: 'Offset for pagination, default 1' } }, required: ['accountId', 'folderId'] } },
        { name: 'search_emails', description: 'Search emails across all folders by keyword', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: ['accountId', 'query'] } },
        { name: 'get_email', description: 'Get full content of a specific email including body', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, messageId: { type: 'string' } }, required: ['accountId', 'messageId'] } },
        { name: 'list_attachments', description: 'List attachments on an email', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, messageId: { type: 'string' } }, required: ['accountId', 'messageId'] } },
        { name: 'get_attachment', description: 'Download and read an attachment — extracts text from PDFs and Word docs', inputSchema: { type: 'object', properties: { accountId: { type: 'string' }, messageId: { type: 'string' }, attachmentId: { type: 'string' } }, required: ['accountId', 'messageId', 'attachmentId'] } }
      ]});
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;

      if (name === 'list_accounts') {
        const data = await zohoGet('https://mail.zoho.com/api/accounts');
        const accounts = unwrap(data).map(a => ({
          id: a.accountId,
          email: a.primaryEmailAddress || a.incomingUserName,
          name: a.displayName || a.accountDisplayName || a.accountName,
          primary: a.isDefaultAccount
        }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }] });
      }

      if (name === 'list_folders') {
        const data = await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/folders`);
        const folders = unwrap(data).map(f => ({
          id: f.folderId,
          name: f.folderName || f.name,
          path: f.path || f.folderPath,
          unread: f.unreadCount,
          total: f.messageCount
        }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(folders, null, 2) }] });
      }

      if (name === 'list_emails') {
        // Correct Zoho API: /messages/view?folderId=xxx&limit=xx&start=xx
        const data = await zohoGet(
          `https://mail.zoho.com/api/accounts/${args.accountId}/messages/view`,
          { folderId: args.folderId, limit: args.limit || 20, start: args.start || 1 }
        );
        const emails = unwrap(data).map(m => ({
          id: m.messageId,
          subject: m.subject,
          from: m.fromAddress || m.sender,
          to: m.toAddress,
          date: m.receivedTime || m.sentTime,
          hasAttachment: m.hasAttachment,
          read: m.isRead !== undefined ? m.isRead : !m.flagRead,
          summary: m.summary || m.snippet
        }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] });
      }

      if (name === 'search_emails') {
        // Correct Zoho search endpoint
        const data = await zohoGet(
          `https://mail.zoho.com/api/accounts/${args.accountId}/messages/search`,
          { searchKey: args.query, start: 1, limit: args.limit || 20 }
        );
        const emails = unwrap(data).map(m => ({
          id: m.messageId,
          subject: m.subject,
          from: m.fromAddress || m.sender,
          date: m.receivedTime || m.sentTime,
          summary: m.summary || m.snippet
        }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] });
      }

      if (name === 'get_email') {
        // Correct endpoint: /messages/view/{messageId} (NOT /messages/{id}/content)
        const data = await zohoGet(
          `https://mail.zoho.com/api/accounts/${args.accountId}/messages/view/${args.messageId}`
        );
        const msg = data.data || data;
        return ok({ content: [{ type: 'text', text: JSON.stringify(msg, null, 2) }] });
      }

      if (name === 'list_attachments') {
        // Correct endpoint: /messages/{messageId}/attachmentDetails
        // Note: Zoho has no standalone list-attachments endpoint - we use message view instead
        const data = await zohoGet(
          `https://mail.zoho.com/api/accounts/${args.accountId}/messages/view/${args.messageId}`
        );
        const msg = data.data || data;
        // Attachments are embedded in the message details
        const attachments = (msg.attachments || []).map(a => ({
          id: a.attachmentId || a.id,
          name: a.attachmentName || a.name || a.fileName,
          size: a.attachmentSize || a.size,
          contentType: a.attachmentType || a.mimeType || a.contentType
        }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(attachments, null, 2) }] });
      }

      if (name === 'get_attachment') {
        const token = await getAccessToken();
        // Correct attachment download URL
        const url = `https://mail.zoho.com/api/accounts/${args.accountId}/messages/view/${args.messageId}/attachment/${args.attachmentId}`;
        const res2 = await axios.get(url, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          responseType: 'arraybuffer'
        });
        const contentType = (res2.headers['content-type'] || '').toLowerCase();
        const buffer = Buffer.from(res2.data);

        if (contentType.includes('pdf')) {
          try {
            const pdfParse = require('pdf-parse');
            const parsed = await pdfParse(buffer);
            return ok({ content: [{ type: 'text', text: `PDF Text Content (pages: ${parsed.numpages}):\n${parsed.text}` }] });
          } catch(e) { return ok({ content: [{ type: 'text', text: `PDF parse error: ${e.message}` }] }); }
        }
        if (contentType.includes('word') || contentType.includes('officedocument') || contentType.includes('msword')) {
          try {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            return ok({ content: [{ type: 'text', text: `Document Text:\n${result.value}` }] });
          } catch(e) { return ok({ content: [{ type: 'text', text: `Word parse error: ${e.message}` }] }); }
        }
        if (contentType.includes('text/plain') || contentType.includes('text/csv') || contentType.includes('text/html')) {
          return ok({ content: [{ type: 'text', text: buffer.toString('utf-8') }] });
        }
        return ok({ content: [{ type: 'text', text: `Binary attachment: ${buffer.length} bytes, content-type: ${contentType}` }] });
      }

      return err(-32601, `Unknown tool: ${name}`);
    }

    if (method === 'notifications/initialized') return res.status(204).end();
    return err(-32601, `Method not found: ${method}`);

  } catch(e) {
    console.error('MCP error:', e.message);
    return err(-32000, e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zoho Mail MCP server running on port ${PORT}`));
