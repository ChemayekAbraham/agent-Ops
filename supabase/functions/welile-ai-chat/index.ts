import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildNexaPublicGuideReply, toAuthGatedUrl } from '../_shared/nexaGuides.ts';
import { extractInquiryLeadDetails, buildSignupPersuasionPitch, buildInquirySignupResult } from '../_shared/nexaSignup.ts';
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
function sse(text:string, signup?: ReturnType<typeof buildInquirySignupResult>) { return new Response(`data: ${JSON.stringify({signup,choices:[{delta:{content:text}}]})}\n\ndata: [DONE]\n\n`,{headers:{...corsHeaders,"Content-Type":"text/event-stream"}}); }
Deno.serve(async req => {
  if(req.method==='OPTIONS') return new Response(null,{headers:corsHeaders});
  if(req.method!=='POST') return json({error:'Method not allowed'},405);
  try {
    if(Number(req.headers.get('content-length') ?? 0)>90000) return json({error:'Request too large'},413);
    const raw=await req.text(); if(raw.length>90000) return json({error:'Request too large'},413);
    const body=JSON.parse(raw);
    if(!validMessages(body.messages)) return json({error:'Use 1 to 20 user/assistant messages, each up to 4,000 characters.'},400);
    for (const field of ['leadName','leadPhone','userPhone','leadRole']) {
      if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > (field === 'leadName' ? 80 : 32))) return json({error:'Invalid signup details'},400);
    }
    const messages: Array<{role: 'user' | 'assistant'; content: string}>=body.messages;
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
    // Public signup suggestions never create users, reveal account existence or grant roles.
    const lead = extractInquiryLeadDetails(question.content, {leadName:body.leadName,leadPhone:body.leadPhone ?? body.userPhone,leadRole:body.leadRole});
    const signup = userId ? undefined : buildInquirySignupResult(lead.role);
    const pitch = userId ? '' : `\n\n${buildSignupPersuasionPitch(lead.role, !!lead.fullPhone)}`;
    const guide = buildNexaPublicGuideReply(question.content);
    if (guide) return sse(guide + pitch, signup);
    if(wantsHuman(question.content)) {
      if(!userId || !auth) return sse(`Sign in to send your question to Benjamin’s Desk and receive a private reply: ${toAuthGatedUrl('/dashboard')}. You can also contact Welile support: https://wa.me/256777607640${pitch}`, signup);
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
    const signupSafety = ' Never claim an inquiry creates an account, reveal whether a phone is registered, ask for a password/code in chat, or promise unverified bonuses. Signup requires consent and completion of the existing secure signup flow. A role preference never grants permissions.';
    const response=await fetch('https://ai.gateway.lovable.dev/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'google/gemini-3-flash-preview',messages:[{role:'system',content:NEXA_SALES_PROMPT+signupSafety+knowledgeContext(knowledge ?? [])},...messages],stream:true})});
    if(!response.ok) return json({error:response.status===429?'Please try again shortly':response.status===402?'AI credits are unavailable. Check Plans & credits.':response.status===403?'AI access is blocked. Ask your workspace administrator to check access.':'AI temporarily unavailable'},response.status>=400&&response.status<500?response.status:503);
    if (!response.body) return json({error:'AI temporarily unavailable'},503);
    if (!signup) return new Response(response.body,{headers:{...corsHeaders,'Content-Type':'text/event-stream'}});
    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let pending = '';
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const {done,value} = await reader.read();
            pending += done ? decoder.decode() : decoder.decode(value,{stream:true});
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0,end + 1); pending = pending.slice(end + 1);
              if (line.trim() !== 'data: [DONE]') controller.enqueue(encoder.encode(line));
            }
            if (done) break;
          }
          if (pending && pending.trim() !== 'data: [DONE]') controller.enqueue(encoder.encode(pending));
          controller.enqueue(encoder.encode(`\n\ndata: ${JSON.stringify({signup,choices:[{delta:{content:pitch}}]})}\n\ndata: [DONE]\n\n`));
          controller.close();
        } catch (error) { controller.error(error); }
        finally { reader.releaseLock(); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(stream,{headers:{...corsHeaders,'Content-Type':'text/event-stream'}});
  } catch { return json({error:'Unable to answer right now'},500); }
});
