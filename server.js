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

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'zoho-mail-mcp', version: '1.4.3' }));

app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body;
  const ok  = (result) => res.json({ jsonrpc: '2.0', id, result });
  const err = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'zoho-mail-mcp', version: '1.4.3' }
      });
    }

    if (method === 'tools/list') {
      return ok({ tools: [
        {
          name: 'list_accounts',
          description: 'List all Zoho Mail accounts',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'list_folders',
          description: 'List folders in a Zoho Mail account',
          inputSchema: {
            type: 'object',
            properties: { accountId: { type: 'string', description: 'Account ID from list_accounts' } },
            required: ['accountId']
          }
        },
        {
          name: 'list_emails',
          description: 'List emails in a folder',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string', description: 'Account ID from list_accounts' },
              folderId:  { type: 'string', description: 'Folder ID from list_folders' },
              limit:     { type: 'number', description: 'Max emails to return (default 20, max 200)' },
              start:     { type: 'number', description: 'Pagination start index (default 1)' }
            },
            required: ['accountId', 'folderId']
          }
        },
        {
          name: 'search_emails',
          description: 'Search emails across the entire mailbox. Supports Zoho structured search syntax (e.g. sender:foo@bar.com, subject:invoice). Use sweep:true to retrieve ALL matching emails across the full mailbox in one call (loops internally, up to 2000 results). Use start+limit for manual pagination.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string', description: 'Account ID from list_accounts' },
              query:     { type: 'string', description: 'Search keyword or Zoho search expression (e.g. "sender:foo@bar.com subject:invoice")' },
              limit:     { type: 'number', description: 'Max results per page (default 50, max 200)' },
              start:     { type: 'number', description: 'Pagination offset, 1-indexed (default 1). Use with limit to page through results.' },
              sweep:     { type: 'boolean', description: 'If true, automatically pages through ALL results and returns the complete set (up to 2000). Ignores start. Use for full-mailbox coverage.' }
            },
            required: ['accountId', 'query']
          }
        },
        {
          name: 'get_email',
          description: 'Get full body content of a specific email. Requires folderId — get it from list_folders or from the folderId field returned by list_emails/search_emails.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string', description: 'Account ID from list_accounts' },
              folderId:  { type: 'string', description: 'Folder ID the email lives in (from list_folders or search_emails result)' },
              messageId: { type: 'string', description: 'Message ID from list_emails or search_emails' }
            },
            required: ['accountId', 'folderId', 'messageId']
          }
        },
        {
          name: 'list_attachments',
          description: 'List attachments on an email. Requires folderId.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId: { type: 'string', description: 'Account ID from list_accounts' },
              folderId:  { type: 'string', description: 'Folder ID the email lives in' },
              messageId: { type: 'string', description: 'Message ID from list_emails or search_emails' }
            },
            required: ['accountId', 'folderId', 'messageId']
          }
        },
        {
          name: 'get_attachment',
          description: 'Download and read an attachment (PDFs and Word docs extracted as text). Requires folderId.',
          inputSchema: {
            type: 'object',
            properties: {
              accountId:    { type: 'string', description: 'Account ID from list_accounts' },
              folderId:     { type: 'string', description: 'Folder ID the email lives in' },
              messageId:    { type: 'string', description: 'Message ID from list_emails or search_emails' },
              attachmentId: { type: 'string', description: 'Attachment ID from list_attachments' }
            },
            required: ['accountId', 'folderId', 'messageId', 'attachmentId']
          }
        }
      ]});
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;

      // ── list_accounts ──────────────────────────────────────────────────────
      if (name === 'list_accounts') {
        const data = await zohoGet('https://mail.zoho.com/api/accounts');
        const accounts = (data.data || []).map(a => ({
          id:      a.accountId,
          email:   a.emailAddress,
          name:    a.displayName,
          primary: a.primaryAccount
        }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }] });
      }

      // ── list_folders ───────────────────────────────────────────────────────
      if (name === 'list_folders') {
        const data = await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/folders`);
        const folders = (data.data || []).map(f => ({
          id:     f.folderId,
          name:   f.folderName,
          path:   f.folderPath,
          unread: f.unreadCount,
          total:  f.messageCount
        }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(folders, null, 2) }] });
      }

      // ── list_emails ────────────────────────────────────────────────────────
      if (name === 'list_emails') {
        const data = await zohoGet(
          `https://mail.zoho.com/api/accounts/${args.accountId}/messages/view`,
          { folderId: args.folderId, limit: args.limit || 20, start: args.start || 1 }
        );
        const emails = (data.data || []).map(m => ({
          id:            m.messageId,
          subject:       m.subject,
          from:          m.fromAddress,
          to:            m.toAddress,
          date:          m.receivedTime,
          folderId:      m.folderId,
          hasAttachment: m.hasAttachment,
          summary:       m.summary
        }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] });
      }

      // ── search_emails ──────────────────────────────────────────────────────
      // Implementation: folder-loop scan (Zoho /messages/search returns 400 for this account).
      // Fetches up to MSGS_PER_FOLDER messages from every folder, filters client-side by keyword.
      // Supports:
      //   - limit: max results to return (default 50, max 200 per single call)
      //   - sweep: true = scan ALL folders with up to SWEEP_CAP total results
      //   - start: 1-indexed offset for single-page pagination (non-sweep mode only)
      //   - Results sorted newest-first by date
      if (name === 'search_emails') {
        const SWEEP_CAP       = 2000;  // hard ceiling for sweep mode
        const MSGS_PER_FOLDER = 200;   // messages fetched per folder per pass
        const userLimit       = Math.min(args.limit || 50, 200);
        const sweep           = args.sweep === true;
        const startOffset     = Math.max((args.start || 1) - 1, 0);  // convert 1-indexed to 0-indexed
        const q               = (args.query || '').toLowerCase();

        // Map a raw Zoho message object to our standard envelope
        const mapMsg = m => ({
          id:            m.messageId,
          subject:       m.subject,
          from:          m.fromAddress,
          to:            m.toAddress,
          date:          m.receivedtime ?? m.receivedTime ?? m.sentDateInGMT,
          folderId:      m.folderId,
          hasAttachment: m.hasAttachment,
          summary:       m.summary
        });

        // Get all folders
        const foldersData = await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/folders`);
        const folders = foldersData.data || [];

        let allMatches = [];
        const cap = sweep ? SWEEP_CAP : userLimit + startOffset + 200; // collect enough to paginate

        for (const folder of folders) {
          if (allMatches.length >= cap) break;
          try {
            const fd = await zohoGet(
              `https://mail.zoho.com/api/accounts/${args.accountId}/messages/view`,
              { folderId: folder.folderId, limit: MSGS_PER_FOLDER }
            );
            const msgs = fd.data || [];
            for (const m of msgs) {
              if (allMatches.length >= cap) break;
              const haystack = `${m.subject||''} ${m.fromAddress||''} ${m.toAddress||''} ${m.summary||''}`.toLowerCase();
              if (haystack.includes(q)) {
                allMatches.push(mapMsg(m));
              }
            }
          } catch (_) { /* skip inaccessible folders */ }
        }

        // Sort all matches newest-first
        allMatches.sort((a, b) => Number(b.date) - Number(a.date));

        let truncated = false;
        let results;

        if (sweep) {
          // Sweep: return up to SWEEP_CAP, flag if cut
          truncated = allMatches.length > SWEEP_CAP;
          results = allMatches.slice(0, SWEEP_CAP);
        } else {
          // Single-page: apply start offset and limit
          const page = allMatches.slice(startOffset, startOffset + userLimit);
          truncated = allMatches.length > startOffset + userLimit;
          results = page;
        }

        return ok({ content: [{ type: 'text', text: JSON.stringify({ total: results.length, truncated, results }, null, 2) }] });
      }

      // ── get_email ──────────────────────────────────────────────────────────
      // Correct endpoint: /api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/content
      if (name === 'get_email') {
        if (!args.folderId) {
          return err(-32602, 'folderId is required. Get it from list_folders or from the folderId field in list_emails/search_emails results.');
        }
        let data;
        try {
          data = await zohoGet(
            `https://mail.zoho.com/api/accounts/${args.accountId}/folders/${args.folderId}/messages/${args.messageId}/content`
          );
        } catch (e) {
          return err(-32000, `Could not fetch email: ${e.response ? 'Zoho ' + e.response.status + ':' + JSON.stringify(e.response.data) : e.message}`);
        }

        const raw = data.data || data;
        let bodyText = '';
        if (raw.content) {
          bodyText = raw.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        }

        const result = {
          messageId: raw.messageId,
          subject:   raw.subject,
          from:      raw.fromAddress || raw.from,
          to:        raw.toAddress   || raw.to,
          date:      raw.receivedTime || raw.date,
          body:      bodyText || JSON.stringify(raw)
        };
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      }

      // ── list_attachments ───────────────────────────────────────────────────
      // Correct endpoint: /api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/attachmentinfo
      if (name === 'list_attachments') {
        if (!args.folderId) {
          return err(-32602, 'folderId is required. Get it from list_folders or from the folderId field in list_emails/search_emails results.');
        }
        let data;
        try {
          data = await zohoGet(
            `https://mail.zoho.com/api/accounts/${args.accountId}/folders/${args.folderId}/messages/${args.messageId}/attachmentinfo`
          );
        } catch (e) {
          return err(-32000, `Could not list attachments: ${e.response ? 'Zoho ' + e.response.status + ':' + JSON.stringify(e.response.data) : e.message}`);
        }
        // Zoho attachmentinfo response: { data: { attachments: [...], messageId: "..." } }
        const rawAtt = data.data || data;
        const attList = Array.isArray(rawAtt.attachments) ? rawAtt.attachments
                      : Array.isArray(rawAtt) ? rawAtt
                      : (rawAtt ? [rawAtt] : []);
        const attachments = attList.map(a => ({
          id:   a.attachmentId,
          name: a.attachmentName,
          size: a.attachmentSize
        }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(attachments, null, 2) }] });
      }

      // ── get_attachment ─────────────────────────────────────────────────────
      // Correct endpoint: /api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/attachments/{attachmentId}
      if (name === 'get_attachment') {
        if (!args.folderId) {
          return err(-32602, 'folderId is required. Get it from list_folders or from the folderId field in list_emails/search_emails results.');
        }
        const token = await getAccessToken();
        const url = `https://mail.zoho.com/api/accounts/${args.accountId}/folders/${args.folderId}/messages/${args.messageId}/attachments/${args.attachmentId}`;
        let res2;
        try {
          res2 = await axios.get(url, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            responseType: 'arraybuffer'
          });
        } catch (e) {
          return err(-32000, `Could not fetch attachment: ${e.response ? 'Zoho ' + e.response.status + ':' + JSON.stringify(e.response.data) : e.message}`);
        }
        const contentType = res2.headers['content-type'] || '';
        const buffer = Buffer.from(res2.data);

        if (contentType.includes('pdf')) {
          try {
            const pdfParse = require('pdf-parse');
            const parsed = await pdfParse(buffer);
            return ok({ content: [{ type: 'text', text: `PDF Text Content:\n${parsed.text}` }] });
          } catch (e) {
            return ok({ content: [{ type: 'text', text: `PDF parse error: ${e.message}` }] });
          }
        }

        if (contentType.includes('word') || contentType.includes('officedocument')) {
          try {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            return ok({ content: [{ type: 'text', text: `Document Text:\n${result.value}` }] });
          } catch (e) {
            return ok({ content: [{ type: 'text', text: `Word parse error: ${e.message}` }] });
          }
        }

        if (contentType.includes('text')) {
          return ok({ content: [{ type: 'text', text: buffer.toString('utf-8') }] });
        }

        return ok({ content: [{ type: 'text', text: `Binary attachment, size: ${buffer.length} bytes, type: ${contentType}` }] });
      }

      return err(-32601, `Unknown tool: ${name}`);
    }

    if (method === 'notifications/initialized') return res.status(204).end();
    return err(-32601, `Method not found: ${method}`);

  } catch (e) {
    // Include full Zoho response body in error for debugging
    const zohoBody = e.response?.data ? JSON.stringify(e.response.data) : '';
    const detail = zohoBody ? `${e.message} — Zoho: ${zohoBody}` : e.message;
    console.error('MCP error:', detail);
    return err(-32603, detail);
  }
});

// TEMP: test native search with entire: prefix syntax (Claude v1.4.3 review)
app.get('/test-native-search', async (req, res) => {
  const query = req.query.q || 'title';
  const accountId = req.query.accountId || '4442947000000008002';
  const searchKey = query.includes(':') ? query : `entire:${query}`;
  try {
    const token = await getAccessToken();
    const axios2 = require('axios');
    const result = await axios2.get(
      `https://mail.zoho.com/api/accounts/${accountId}/messages/search`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { searchKey, limit: 5, start: 1 }
      }
    );
    return res.json({
      searchKey,
      status: result.status,
      zohoStatus: result.data?.status,
      count: Array.isArray(result.data?.data) ? result.data.data.length : 'non-array',
      firstSubject: result.data?.data?.[0]?.subject || null,
      rawData: result.data
    });
  } catch (e) {
    return res.json({
      searchKey,
      error: e.message,
      zohoError: e.response?.data || null
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zoho Mail MCP server v1.4.3 running on port ${PORT}`));
