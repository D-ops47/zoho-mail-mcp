const express=require('express'),axios=require('axios'),app=express();
app.use(express.json());
const CLIENT_ID=process.env.ZOHO_CLIENT_ID,CLIENT_SECRET=process.env.ZOHO_CLIENT_SECRET,REFRESH_TOKEN=process.env.ZOHO_REFRESH_TOKEN;
let accessToken=null,tokenExpiry=0;
async function getAccessToken(){if(accessToken&&Date.now()<tokenExpiry-60000)return accessToken;const r=await axios.post('https://accounts.zoho.com/oauth/v2/token',null,{params:{grant_type:'refresh_token',client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:REFRESH_TOKEN}});if(!r.data.access_token)throw new Error('Token refresh failed');accessToken=r.data.access_token;tokenExpiry=Date.now()+(r.data.expires_in*1000);console.log('Token refreshed');return accessToken;}
async function zg(url,p){const t=await getAccessToken();try{const r=await axios.get(url,{headers:{Authorization:`Zoho-oauthtoken ${t}`},params:p});return r.data;}catch(e){throw new Error(`Zoho ${e.response?.status}:${JSON.stringify(e.response?.data||e.message)}`);}}
const uw=d=>{if(!d)return[];if(Array.isArray(d))return d;if(d.data&&Array.isArray(d.data))return d.data;if(d.data)return[d.data];return[d];};
app.get('/health',(q,s)=>s.json({status:'ok',service:'zoho-mail-mcp'}));
app.get('/debug',async(q,s)=>{try{const t=await getAccessToken();const ar=await axios.get('https://mail.zoho.com/api/accounts',{headers:{Authorization:`Zoho-oauthtoken ${t}`}});const ac=uw(ar.data);const aid=ac[0]?.accountId;let ft=null;try{const fr=await axios.get(`https://mail.zoho.com/api/accounts/${aid}/folders`,{headers:{Authorization:`Zoho-oauthtoken ${t}`}});ft={ok:true,count:uw(fr.data).length};}catch(e){ft={err:e.response?.status};}s.json({ok:true,accountId:aid,email:ac[0]?.primaryEmailAddress,folders:ft});}catch(e){s.json({error:e.message});}});
app.post('/mcp',async(q,s)=>{
const{method,params,id}=q.body;
const ok=r=>s.json({jsonrpc:'2.0',id,result:r});
const er=(c,m)=>s.json({jsonrpc:'2.0',id,error:{code:c,message:m}});
try{
if(method==='initialize')return ok({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'zoho-mail-mcp',version:'1.0.0'}});
if(method==='tools/list')return ok({tools:[
  {name:'list_accounts',description:'List all Zoho Mail accounts',inputSchema:{type:'object',properties:{}}},
  {name:'list_folders',description:'List folders in a Zoho Mail account',inputSchema:{type:'object',properties:{accountId:{type:'string'}},required:['accountId']}},
  {name:'list_emails',description:'List emails in a folder (use list_folders first to get folderId)',inputSchema:{type:'object',properties:{accountId:{type:'string'},folderId:{type:'string'},limit:{type:'number'},start:{type:'number'}},required:['accountId','folderId']}},
  {name:'search_emails',description:'Search emails by keyword across all folders',inputSchema:{type:'object',properties:{accountId:{type:'string'},query:{type:'string'},limit:{type:'number'}},required:['accountId','query']}},
  {name:'get_email',description:'Get full body and content of an email (also returns attachments list)',inputSchema:{type:'object',properties:{accountId:{type:'string'},messageId:{type:'string'},folderId:{type:'string',description:'Optional: folder ID to fetch from. Use Inbox folder ID if known.'}},required:['accountId','messageId']}},
  {name:'list_attachments',description:'List attachments on an email',inputSchema:{type:'object',properties:{accountId:{type:'string'},messageId:{type:'string'},folderId:{type:'string'}},required:['accountId','messageId']}},
  {name:'get_attachment',description:'Download attachment content - extracts text from PDFs and Word docs',inputSchema:{type:'object',properties:{accountId:{type:'string'},messageId:{type:'string'},attachmentId:{type:'string'}},required:['accountId','messageId','attachmentId']}}
]});
if(method==='tools/call'){
  const{name,arguments:a}=params;
  if(name==='list_accounts'){const d=await zg('https://mail.zoho.com/api/accounts');return ok({content:[{type:'text',text:JSON.stringify(uw(d).map(x=>({id:x.accountId,email:x.primaryEmailAddress||x.incomingUserName,name:x.displayName||x.accountDisplayName,primary:x.isDefaultAccount})),null,2)}]});}
  if(name==='list_folders'){const d=await zg(`https://mail.zoho.com/api/accounts/${a.accountId}/folders`);return ok({content:[{type:'text',text:JSON.stringify(uw(d).map(f=>({id:f.folderId,name:f.folderName,path:f.path||f.folderPath,unread:f.unreadCount,total:f.messageCount})),null,2)}]});}
  if(name==='list_emails'){const d=await zg(`https://mail.zoho.com/api/accounts/${a.accountId}/messages/view`,{folderId:a.folderId,limit:a.limit||20,start:a.start||1});return ok({content:[{type:'text',text:JSON.stringify(uw(d).map(m=>({id:m.messageId,subject:m.subject,from:m.fromAddress||m.sender,to:m.toAddress,date:m.receivedTime||m.sentTime,hasAttachment:m.hasAttachment,summary:m.summary})),null,2)}]});}
  if(name==='search_emails'){
    try{const d=await zg(`https://mail.zoho.com/api/accounts/${a.accountId}/messages/search`,{searchKey:a.query});return ok({content:[{type:'text',text:JSON.stringify(uw(d).map(m=>({id:m.messageId,subject:m.subject,from:m.fromAddress||m.sender,date:m.receivedTime||m.sentTime,summary:m.summary})),null,2)}]});}
    catch(e){if(e.message.includes('Index')&&e.message.includes('out of bounds'))return ok({content:[{type:'text',text:'[]'}]});throw e;}
  }
  if(name==='get_email'||name==='list_attachments'){
    // Fetch message - try multiple approaches
    let msg=null,msgErr=null;
    // Approach 1: use view endpoint with messageId param (works with or without folderId)
    const params1={messageId:a.messageId};
    if(a.folderId)params1.folderId=a.folderId;
    try{const d=await zg(`https://mail.zoho.com/api/accounts/${a.accountId}/messages/view`,params1);const items=uw(d);const found=items.find(m=>m.messageId===a.messageId)||items[0];if(found)msg=found;}catch(e1){msgErr=e1.message;}
    // Approach 2: messagecontent endpoint
    if(!msg){try{const d=await zg(`https://mail.zoho.com/api/accounts/${a.accountId}/messages/${a.messageId}/messagecontent`);msg=d.data||d;}catch(e2){}}
    if(name==='get_email'){
      if(!msg)throw new Error('Could not fetch email: '+msgErr);
      return ok({content:[{type:'text',text:JSON.stringify(msg,null,2)}]});
    }
    // list_attachments
    const att=(msg?.attachments||msg?.attachment||[]).map(x=>({id:x.attachmentId||x.id,name:x.attachmentName||x.name,size:x.attachmentSize||x.size,contentType:x.attachmentType||x.mimeType}));
    return ok({content:[{type:'text',text:JSON.stringify(att,null,2)}]});
  }
  if(name==='get_attachment'){
    const t=await getAccessToken();
    const url=`https://mail.zoho.com/api/accounts/${a.accountId}/messages/${a.messageId}/attachment/${a.attachmentId}`;
    const r2=await axios.get(url,{headers:{Authorization:`Zoho-oauthtoken ${t}`},responseType:'arraybuffer'});
    const ct=(r2.headers['content-type']||'').toLowerCase(),buf=Buffer.from(r2.data);
    if(ct.includes('pdf')){try{const p=require('pdf-parse');const x=await p(buf);return ok({content:[{type:'text',text:`PDF (${x.numpages} pages):\n${x.text}`}]});}catch(e){return ok({content:[{type:'text',text:`PDF error:${e.message}`}]});}}
    if(ct.includes('word')||ct.includes('officedocument')){try{const m=require('mammoth');const r=await m.extractRawText({buffer:buf});return ok({content:[{type:'text',text:`Doc:\n${r.value}`}]});}catch(e){return ok({content:[{type:'text',text:`Word error:${e.message}`}]});}}
    if(ct.includes('text/'))return ok({content:[{type:'text',text:buf.toString('utf-8')}]});
    return ok({content:[{type:'text',text:`Binary:${buf.length}b type:${ct}`}]});
  }
  return er(-32601,`Unknown tool:${name}`);
}
if(method==='notifications/initialized')return s.status(204).end();
return er(-32601,`Method not found:${method}`);
}catch(e){console.error('MCP:',e.message);return er(-32000,e.message);}
});
app.listen(process.env.PORT||3000,()=>console.log('Zoho Mail MCP running'));