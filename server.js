const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());
const CLIENT_ID=process.env.ZOHO_CLIENT_ID,CLIENT_SECRET=process.env.ZOHO_CLIENT_SECRET,REFRESH_TOKEN=process.env.ZOHO_REFRESH_TOKEN;
let accessToken=null,tokenExpiry=0;
async function getAccessToken(){if(accessToken&&Date.now()<tokenExpiry-60000)return accessToken;const res=await axios.post('https://accounts.zoho.com/oauth/v2/token',null,{params:{grant_type:'refresh_token',client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:REFRESH_TOKEN}});if(!res.data.access_token)throw new Error('Token refresh failed: '+JSON.stringify(res.data));accessToken=res.data.access_token;tokenExpiry=Date.now()+(res.data.expires_in*1000);console.log('Token refreshed');return accessToken;}
async function zohoGet(url,params){const token=await getAccessToken();try{const res=await axios.get(url,{headers:{Authorization:`Zoho-oauthtoken ${token}`},params});return res.data;}catch(e){throw new Error(`Zoho API ${e.response?.status}: ${JSON.stringify(e.response?.data||e.message)}`);}}
function unwrap(d){if(!d)return[];if(Array.isArray(d))return d;if(d.data&&Array.isArray(d.data))return d.data;if(d.data)return[d.data];return[d];}
app.get('/health',(req,res)=>res.json({status:'ok',service:'zoho-mail-mcp'}));
app.get('/debug',async(req,res)=>{try{const token=await getAccessToken();const ar=await axios.get('https://mail.zoho.com/api/accounts',{headers:{Authorization:`Zoho-oauthtoken ${token}`}});const accs=unwrap(ar.data);const aid=accs[0]?.accountId;let ft=null;try{const fr=await axios.get(`https://mail.zoho.com/api/accounts/${aid}/folders`,{headers:{Authorization:`Zoho-oauthtoken ${token}`}});ft={status:fr.status,count:unwrap(fr.data).length};}catch(fe){ft={error:fe.response?.status};}res.json({tokenOk:true,accountId:aid,accountEmail:accs[0]?.primaryEmailAddress,folderTest:ft});}catch(e){res.json({error:e.message});}});
app.post('/mcp',async(req,res)=>{
const{method,params,id}=req.body;
const ok=r=>res.json({jsonrpc:'2.0',id,result:r});
const err=(c,m)=>res.json({jsonrpc:'2.0',id,error:{code:c,message:m}});
try{
if(method==='initialize')return ok({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'zoho-mail-mcp',version:'1.0.0'}});
if(method==='tools/list')return ok({tools:[
  {name:'list_accounts',description:'List all Zoho Mail accounts',inputSchema:{type:'object',properties:{}}},
  {name:'list_folders',description:'List folders in a Zoho Mail account',inputSchema:{type:'object',properties:{accountId:{type:'string'}},required:['accountId']}},
  {name:'list_emails',description:'List emails in a folder',inputSchema:{type:'object',properties:{accountId:{type:'string'},folderId:{type:'string'},limit:{type:'number'},start:{type:'number'}},required:['accountId','folderId']}},
  {name:'search_emails',description:'Search emails by keyword',inputSchema:{type:'object',properties:{accountId:{type:'string'},query:{type:'string'},limit:{type:'number'}},required:['accountId','query']}},
  {name:'get_email',description:'Get full content of an email including body',inputSchema:{type:'object',properties:{accountId:{type:'string'},messageId:{type:'string'}},required:['accountId','messageId']}},
  {name:'list_attachments',description:'List attachments on an email',inputSchema:{type:'object',properties:{accountId:{type:'string'},messageId:{type:'string'}},required:['accountId','messageId']}},
  {name:'get_attachment',description:'Download attachment - extracts text from PDFs and Word docs',inputSchema:{type:'object',properties:{accountId:{type:'string'},messageId:{type:'string'},attachmentId:{type:'string'}},required:['accountId','messageId','attachmentId']}}
]});
if(method==='tools/call'){
  const{name,arguments:args}=params;
  if(name==='list_accounts'){const d=await zohoGet('https://mail.zoho.com/api/accounts');const a=unwrap(d).map(a=>({id:a.accountId,email:a.primaryEmailAddress||a.incomingUserName,name:a.displayName||a.accountDisplayName,primary:a.isDefaultAccount}));return ok({content:[{type:'text',text:JSON.stringify(a,null,2)}]});}
  if(name==='list_folders'){const d=await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/folders`);const f=unwrap(d).map(f=>({id:f.folderId,name:f.folderName,path:f.path||f.folderPath,unread:f.unreadCount,total:f.messageCount}));return ok({content:[{type:'text',text:JSON.stringify(f,null,2)}]});}
  if(name==='list_emails'){const d=await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/messages/view`,{folderId:args.folderId,limit:args.limit||20,start:args.start||1});const e=unwrap(d).map(m=>({id:m.messageId,subject:m.subject,from:m.fromAddress||m.sender,to:m.toAddress,date:m.receivedTime||m.sentTime,hasAttachment:m.hasAttachment,summary:m.summary}));return ok({content:[{type:'text',text:JSON.stringify(e,null,2)}]});}

      if (name === 'get_email') {
        // Try multiple URL patterns - Zoho API varies by account/region
        const baseUrl = `https://mail.zoho.com/api/accounts/${args.accountId}`;
        const urls = [
          `${baseUrl}/messages/${args.messageId}/messagecontent`,
          `${baseUrl}/messages/view/${args.messageId}`,
          `${baseUrl}/messages/${args.messageId}/content`
        ];
        let lastErr = null;
        for (const url of urls) {
          try {
            const d = await zohoGet(url);
            const msg = d.data || d;
            return ok({ content: [{ type: 'text', text: JSON.stringify(msg, null, 2) }] });
          } catch(e) {
            lastErr = e.message;
            continue;
          }
        }
        throw new Error(lastErr);
      }


      if (name === 'search_emails') {
        // Try different search param combinations
        let d = null, lastErr = null;
        const searchAttempts = [
          { searchKey: args.query, start: 0, limit: args.limit || 20 },
          { searchKey: args.query, limit: args.limit || 20 },
          { word: args.query, start: 0, limit: args.limit || 20 }
        ];
        for (const searchParams of searchAttempts) {
          try {
            d = await zohoGet(`https://mail.zoho.com/api/accounts/${args.accountId}/messages/search`, searchParams);
            break;
          } catch(e) { lastErr = e.message; continue; }
        }
        if (!d) throw new Error(lastErr);
        const emails = unwrap(d).map(m => ({ id: m.messageId, subject: m.subject, from: m.fromAddress || m.sender, date: m.receivedTime || m.sentTime, summary: m.summary }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(emails, null, 2) }] });
      }


      if (name === 'list_attachments') {
        const baseUrl = `https://mail.zoho.com/api/accounts/${args.accountId}`;
        const urls = [
          `${baseUrl}/messages/${args.messageId}/messagecontent`,
          `${baseUrl}/messages/view/${args.messageId}`,
          `${baseUrl}/messages/${args.messageId}/content`
        ];
        let msg = null;
        for (const url of urls) {
          try { const d = await zohoGet(url); msg = d.data || d; break; } catch(e) { continue; }
        }
        if (!msg) {
          // If we can't get message content, return empty list
          return ok({ content: [{ type: 'text', text: '[]' }] });
        }
        const attachments = (msg.attachments || msg.attachment || []).map(a => ({
          id: a.attachmentId || a.id, name: a.attachmentName || a.name,
          size: a.attachmentSize || a.size, contentType: a.attachmentType || a.mimeType
        }));
        return ok({ content: [{ type: 'text', text: JSON.stringify(attachments, null, 2) }] });
      }

  if(name==='get_attachment'){
    const token=await getAccessToken();
    const url=`https://mail.zoho.com/api/accounts/${args.accountId}/messages/${args.messageId}/attachment/${args.attachmentId}`;
    const r2=await axios.get(url,{headers:{Authorization:`Zoho-oauthtoken ${token}`},responseType:'arraybuffer'});
    const ct=(r2.headers['content-type']||'').toLowerCase();
    const buf=Buffer.from(r2.data);
    if(ct.includes('pdf')){try{const p=require('pdf-parse');const parsed=await p(buf);return ok({content:[{type:'text',text:`PDF (${parsed.numpages} pages):\n${parsed.text}`}]});}catch(e){return ok({content:[{type:'text',text:`PDF error: ${e.message}`}]});}}
    if(ct.includes('word')||ct.includes('officedocument')){try{const m=require('mammoth');const r=await m.extractRawText({buffer:buf});return ok({content:[{type:'text',text:`Doc:\n${r.value}`}]});}catch(e){return ok({content:[{type:'text',text:`Word error: ${e.message}`}]});}}
    if(ct.includes('text/'))return ok({content:[{type:'text',text:buf.toString('utf-8')}]});
    return ok({content:[{type:'text',text:`Binary: ${buf.length} bytes, type: ${ct}`}]});
  }
  return err(-32601,`Unknown tool: ${name}`);
}
if(method==='notifications/initialized')return res.status(204).end();
return err(-32601,`Method not found: ${method}`);
}catch(e){console.error('MCP error:',e.message);return err(-32000,e.message);}
});
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Zoho Mail MCP server running on port ${PORT}`));