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

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'zoho-mail-mcp', version: '1.5.1' }));

app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body;
  const ok  = (result) => res.json({ jsonrpc: '2.0', id, result });
  const err = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'zoho-mail-mcp', version: '1.5.1' }
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
      // PRIMARY: Zoho native /messages/search (full-body, true cross-folder, all Zoho operators).
      //   - Bare queries are auto-prefixed with 'entire:' (Zoho requires 'param:value' syntax).
      //   - Supports start/limit pagination and sweep:true for full-mailbox collection.
      // FALLBACK: folder-loop scan if native returns non-200 (metadata+snippet only).
      if (name === 'search_emails') {
        const SWEEP_CAP   = 2000;  // hard ceiling for sweep mode
        const PAGE_SIZE   = 200;   // Zoho's per-call maximum for native search
        const userLimit   = Math.min(args.limit || 50, PAGE_SIZE);
        const sweep       = args.sweep === true;
        const startOffset = Math.max((args.start || 1) - 1, 0);  // 1-indexed to 0-indexed

        // Auto-prefix bare queries with 'entire:' — Zoho requires 'param:value' syntax.
        // If query already contains a Zoho operator (has ':'), pass it through untouched.
        const rawQuery  = args.query || '';
        const searchKey = rawQuery.includes(':') ? rawQuery : `entire:${rawQuery}`;

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

        // ── Helper: fetch one page from native search with 429 retry ─────────────────────
        const nativePage = async (start) => {
          const MAX_RETRIES = 3;
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
              return await zohoGet(
                `https://mail.zoho.com/api/accounts/${args.accountId}/messages/search`,
                { searchKey, start, limit: PAGE_SIZE }
              );
            } catch (e) {
              if (e.response?.status === 429 && attempt < MAX_RETRIES - 1) {
                await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
              } else {
                throw e;
              }
            }
          }
        };

        // ── Try native search ──────────────────────────────────────────────────────
        let nativeWorked = false;
        let allResults   = [];
        let truncated    = false;

        try {
          if (!sweep) {
            // Single-page native search.
            // NOTE: Zoho ignores the limit param and always returns up to 200 results.
            // We slice client-side to honour the user's requested limit.
            // The start param works correctly in 200-item increments.
            const data = await nativePage(args.start || 1);
            const raw  = data.data || data;
            const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
            const mapped = list.map(mapMsg);
            mapped.sort((a, b) => Number(b.date) - Number(a.date));
            // Client-side slice to requested limit
            const sliced   = mapped.slice(0, userLimit);
            truncated = list.length > userLimit;
            return ok({ content: [{ type: 'text', text: JSON.stringify({ total: sliced.length, truncated, results: sliced, source: 'native' }, null, 2) }] });
          }

          // Sweep: page through all native results
          let cursor = 1;
          while (true) {
            const data = await nativePage(cursor);
            const raw  = data.data || data;
            const page = Array.isArray(raw) ? raw : (raw ? [raw] : []);
            if (page.length === 0) break;
            allResults = allResults.concat(page.map(mapMsg));
            cursor += PAGE_SIZE;
            if (allResults.length > SWEEP_CAP) {
              truncated  = true;
              allResults = allResults.slice(0, SWEEP_CAP);
              break;
            }
            if (page.length < PAGE_SIZE) break;
          }
          nativeWorked = true;
        } catch (nativeErr) {
          // Native search failed — fall through to folder-loop
          console.error('Native search failed, falling back to folder-loop:', nativeErr.message);
        }

        if (nativeWorked) {
          allResults.sort((a, b) => Number(b.date) - Number(a.date));
          return ok({ content: [{ type: 'text', text: JSON.stringify({ total: allResults.length, truncated, results: allResults, source: 'native' }, null, 2) }] });
        }

        // ── Fallback: folder-loop scan (metadata + snippet only) ────────────────────────
        const MSGS_PER_FOLDER = 200;
        const q = rawQuery.toLowerCase();
        const foldersData = await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/folders`);
        const folders = foldersData.data || [];
        let fallbackMatches = [];
        const cap = sweep ? SWEEP_CAP : userLimit + startOffset + 200;

        for (const folder of folders) {
          if (fallbackMatches.length >= cap) break;
          try {
            const fd = await zohoGet(
              `https://mail.zoho.com/api/accounts/${args.accountId}/messages/view`,
              { folderId: folder.folderId, limit: MSGS_PER_FOLDER }
            );
            const msgs = fd.data || [];
            for (const m of msgs) {
              if (fallbackMatches.length >= cap) break;
              const haystack = `${m.subject||''} ${m.fromAddress||''} ${m.toAddress||''} ${m.summary||''}`.toLowerCase();
              if (haystack.includes(q)) fallbackMatches.push(mapMsg(m));
            }
          } catch (_) { /* skip inaccessible folders */ }
        }

        fallbackMatches.sort((a, b) => Number(b.date) - Number(a.date));
        let fbResults;
        if (sweep) {
          truncated = fallbackMatches.length > SWEEP_CAP;
          fbResults = fallbackMatches.slice(0, SWEEP_CAP);
        } else {
          const page = fallbackMatches.slice(startOffset, startOffset + userLimit);
          truncated = fallbackMatches.length > startOffset + userLimit;
          fbResults = page;
        }
        return ok({ content: [{ type: 'text', text: JSON.stringify({ total: fbResults.length, truncated, results: fbResults, source: 'folder-loop-fallback' }, null, 2) }] });
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


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zoho Mail MCP server v1.5.1 running on port ${PORT}`));
