import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { NEXA_SALES_PROMPT, wantsHuman, validMessages, knowledgeContext, isRestrictedInternalStaffQuery, buildInternalStaffRefusalReply } from "../_shared/nexa.ts";
const corsHeaders = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version" };
const json = (data: unknown, status=200) => new Response(JSON.stringify(data), {status,headers:{...corsHeaders,"Content-Type":"application/json"}});
const buckets = new Map<string,{count:number;at:number}>();
function allowed(key:string):boolean {
  const now=Date.now(); const old=buckets.get(key);
  if (buckets.size>2000) for (const [k,v] of buckets) if(now-v.at>60000) buckets.delete(k);
  if(!old || now-old.at>60000) { buckets.set(key,{count:1,at:now}); return true; }
  old.count++; return old.count<=15;
}
function sse(text:string) { return new Response(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\ndata: [DONE]\n\n`,{headers:{...corsHeaders,"Content-Type":"text/event-stream"}}); }
Deno.serve(async req => {
  if(req.method==='OPTIONS') return new Response(null,{headers:corsHeaders});
  if(req.method!=='POST') return json({error:'Method not allowed'},405);
  try {
    if(Number(req.headers.get('content-length') ?? 0)>90000) return json({error:'Request too large'},413);
    const raw=await req.text(); if(raw.length>90000) return json({error:'Request too large'},413);
    const body=JSON.parse(raw);
    if(!validMessages(body.messages)) return json({error:'Use 1 to 20 user/assistant messages, each up to 4,000 characters.'},400);
    const messages=body.messages;
    const question=messages[messages.length-1];
    if(question.role!=='user') return json({error:'Last message must be from the user'},400);
    const url=Deno.env.get('SUPABASE_URL'); const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'); const anon=Deno.env.get('SUPABASE_ANON_KEY');
    if(!url || !service || !anon) return json({error:'Service unavailable'},503);
    const admin=createClient(url,service);
    const auth=req.headers.get('Authorization');
    let userId:string|null=null;
    if(auth?.startsWith('Bearer ')) {
      const {data,error}=await admin.auth.getUser(auth.slice(7));
      if(error || !data.user) return json({error:'Please sign in again'},401);
      userId=data.user.id;
    }
    if(!allowed(userId ?? req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'public')) return json({error:'Please wait before asking again'},429);
    if(messages.some(m => m.role === 'user' && isRestrictedInternalStaffQuery(m.content))) return sse(buildInternalStaffRefusalReply());
    if(wantsHuman(question.content)) {
      if(!userId || !auth) return sse('Sign in to send your question to Benjamin’s Desk and receive a private reply. You can also contact Welile support: https://wa.me/256777607640');
      const client=createClient(url,anon,{global:{headers:{Authorization:auth}}});
      const lastReply=[...messages].reverse().find(m=>m.role==='assistant')?.content ?? null;
      const {error}=await client.rpc('nexa_submit_escalation',{p_question:question.content,p_last_reply:lastReply,p_context:messages.slice(-6)});
      if(error) return json({error:'Your question could not be sent. Please try again later or contact Welile support.'},503);
      return sse('Your question has been sent to Benjamin’s Desk. The desk reply will appear here when it is available.');
    }
    // Only general knowledge is exposed to anonymous visitors; scoped rows require verified roles.
    let scopes=['all'];
    if(userId) {
      const {data}=await admin.from('user_roles').select('role').eq('user_id',userId).eq('enabled',true);
      scopes=[...scopes,...(data ?? []).map(r=>r.role)];
    }
    const {data:knowledge}=await admin.from('nexa_learned_knowledge').select('topic,question_pattern,canonical_answer').eq('active',true).in('role_scope',scopes).order('created_at',{ascending:false}).limit(20);
    const key=Deno.env.get('LOVABLE_API_KEY'); if(!key) return json({error:'AI not configured'},503);
    const response=await fetch('https://ai.gateway.lovable.dev/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'google/gemini-3-flash-preview',messages:[{role:'system',content:NEXA_SALES_PROMPT+knowledgeContext(knowledge ?? [])},...messages],stream:true})});
    if(!response.ok) return json({error:response.status===429?'Please try again shortly':response.status===402?'AI credits are unavailable. Check Plans & credits.':response.status===403?'AI access is blocked. Ask your workspace administrator to check access.':'AI temporarily unavailable'},response.status>=400&&response.status<500?response.status:503);
    return new Response(response.body,{headers:{...corsHeaders,'Content-Type':'text/event-stream'}});
  } catch { return json({error:'Unable to answer right now'},500); }
});
