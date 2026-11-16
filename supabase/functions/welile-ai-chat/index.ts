
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildNexaPublicGuideReply, isFinancialAccessQuery, toAuthGatedUrl } from '../_shared/nexaGuides.ts';
import { extractInquiryLeadDetails, buildSignupPersuasionPitch, buildInquirySignupResult } from '../_shared/nexaSignup.ts';
import { buildNexaSystemPrompt, groundReply, wantsHuman, validMessages, knowledgeContext, isRestrictedInternalStaffQuery, buildInternalStaffRefusalReply } from "../_shared/nexa.ts";
import { buildNexaToolDefs, runNexaTool, normalizePortfolioRow, isPortfolioOrReturnsQuestion, type PortfolioReader, type MyRateReader, type ProfileReader } from "../_shared/nexaTools.ts";
import { cachedPublicPolicy, readQuoteRate } from "../_shared/partnerReturnPolicy.ts";
import { requestPortfolioOtp, verifyPortfolioOtp, portfolioIdFromSession, auditPortfolioAccess, sha256Hex } from "../_shared/nexaPortfolioAccess.ts";
import { isStaff, recordAccessAlert, channelFrom } from "../_shared/nexaAccess.ts";
import { bearerHasSub, noUserResult } from "../_shared/bearerHasSub.ts";
const MAX_TOOL_ROUNDS = 3;
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
    const ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'public';
    // Portfolio verification for callers who are not signed in. Codes and OTPs travel in
    // structured fields only, never in chat messages, so they never reach the AI model.
    if(body.portfolioVerify!==undefined) {
      const v=body.portfolioVerify;
      const vurl=Deno.env.get('SUPABASE_URL'); const vservice=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if(!vurl || !vservice) return json({error:'Service unavailable'},503);
      if(!allowed(`verify:${ip}`)) return json({error:'Please wait before trying again'},429);
      const vadmin=createClient(vurl,vservice);
      let vUser:string|null=null; const vauth=req.headers.get('Authorization');
      if(vauth?.startsWith('Bearer ')) { const {data}=await vadmin.auth.getUser(vauth.slice(7)); vUser=data?.user?.id ?? null; }
      const vctx={userId:vUser,phone:typeof body.userPhone==='string'?body.userPhone:null,channel:channelFrom(body.channel)};
      if(v?.action==='request') { const r=await requestPortfolioOtp(vadmin,v.portfolioCode,ip,vctx); return r.ok?json({challengeId:r.challengeId,message:r.message}):json({error:r.message},r.status); }
      if(v?.action==='verify') { const r=await verifyPortfolioOtp(vadmin,v.challengeId,v.otp,ip,vctx); return r.ok?json({portfolioSession:r.sessionToken,expiresInSeconds:r.expiresInSeconds}):json({error:r.message},400); }
      return json({error:'Invalid verification request'},400);
    }
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
    // The caller check and the public Returns policy are read in parallel. The policy is the PUBLIC
    // new-partner rate (60 s isolate cache, display only); null = unknown, so replies give no figure.
    const jwt=auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const [userRes, policy]=await Promise.all([jwt ? (bearerHasSub(jwt) ? admin.auth.getUser(jwt) : noUserResult()) : Promise.resolve(null), cachedPublicPolicy(admin)]);
    const publicRate=policy?.newContractRate ?? null;
    if(jwt) {
      if(!userRes || userRes.error || !userRes.data.user) return json({error:'Please sign in again'},401);
      userId=userRes.data.user.id;
    }
    if(!allowed(userId ?? req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'public')) return json({error:'Please wait before asking again'},429);
    const channel=channelFrom(body.channel);
    const callerPhone=typeof body.userPhone==='string'?body.userPhone:null;
    if(messages.some(m => m.role === 'user' && isRestrictedInternalStaffQuery(m.content))) {
      // Refusal applies to everyone (defense in depth); alert only for non-staff callers.
      let rr:string[]=[];
      if(userId) { const {data}=await admin.from('user_roles').select('role').eq('user_id',userId).eq('enabled',true); rr=(data ?? []).map(r=>String(r.role)); }
      if(!isStaff(rr)) await recordAccessAlert(admin,{userId,phone:callerPhone,channel,roles:rr,attemptedResource:'internal_staff_query',userMessage:[...messages].reverse().find(m=>m.role==='user' && isRestrictedInternalStaffQuery(m.content))?.content ?? null,reason:'Non-staff caller asked for internal staff-only information'});
      return sse(buildInternalStaffRefusalReply());
    }
    // Public signup suggestions never create users, reveal account existence or grant roles.
    const lead = extractInquiryLeadDetails(question.content, {leadName:body.leadName,leadPhone:body.leadPhone ?? body.userPhone,leadRole:body.leadRole});
    const signup = userId ? undefined : buildInquirySignupResult(lead.role);
    const pitch = userId ? '' : `\n\n${buildSignupPersuasionPitch(lead.role, !!lead.fullPhone, publicRate)}`;
    const guide = buildNexaPublicGuideReply(question.content, !!userId, publicRate);
    // Portfolio and Returns questions use the server tools. A canned guide would
    // quote a single rate and refuse the caller's own portfolio.
    if (guide && !isPortfolioOrReturnsQuestion(question.content)) return sse(guide + (isFinancialAccessQuery(question.content) ? '' : pitch), signup);
    if(wantsHuman(question.content)) {
      if(!userId || !auth) return sse(`Sign in to send your question to Benjamin’s Desk and receive a private reply: ${toAuthGatedUrl('/dashboard')}. You can also contact Welile support: https://wa.me/256777607640${pitch}`, signup);
      const client=createClient(url,anon,{global:{headers:{Authorization:auth}}});
      const lastReply=[...messages].reverse().find(m=>m.role==='assistant')?.content ?? null;
      const {error}=await client.rpc('nexa_submit_escalation',{p_question:question.content,p_last_reply:lastReply,p_context:messages.slice(-6)});
      if(error) return json({error:'Your question could not be sent. Please try again later or contact Welile support.'},503);
      return sse('Your question has been sent to Benjamin’s Desk. The desk reply will appear here when it is available.');
    }
    let verifiedRoles:string[]=[];
    if(userId) {
      const {data}=await admin.from('user_roles').select('role').eq('user_id',userId).eq('enabled',true);
      verifiedRoles=(data ?? []).map(r=>String(r.role));
    }
    // Portfolio reads: signed-in callers read only their own rows through auth.uid();
    // verified-session callers read only the one portfolio their OTP session is scoped to.
    let readPortfolios:PortfolioReader|null=null;
    // The caller's own rate for a NEW portfolio: only for a user JWT (partner_quote_rate('me') reads
    // auth.uid()). OTP portfolio sessions and anonymous callers never get it.
    let readMyRate:MyRateReader|undefined;
    let readMyProfile:ProfileReader|undefined;
    if(userId && auth) {
      const userClient=createClient(url,anon,{global:{headers:{Authorization:auth}}});
      readPortfolios=async()=>{ const {data,error}=await userClient.rpc('nexa_get_my_portfolios'); return error?{error:'Portfolio data is unavailable right now.'}:{portfolios:(data ?? []).map(normalizePortfolioRow)}; };
      // One partner_quote_rate read per request, shared by get_my_returns_rate and the estimate default.
      let myRate:ReturnType<MyRateReader>|null=null;
      readMyRate=()=>(myRate ??= readQuoteRate(userClient,'me').then((r):Awaited<ReturnType<MyRateReader>>=>r===null?{error:'Your rate is unavailable right now.'}:{rate:r}));
      const nonempty=(v:unknown)=>typeof v==='string' && v.trim()!=='';
      readMyProfile=async()=>{
        const {data,error}=await userClient.from('profiles').select('verified,phone_verified,identity_photos_submitted_at,national_id_photo_path,national_id_back_photo_path,selfie_photo_path').eq('id',userId).maybeSingle();
        if(error || !data) return {error:'Your profile is unavailable right now.'};
        return {
          verified:!!data.verified,
          phone_verified:!!data.phone_verified,
          identity_photos_submitted_at:(data.identity_photos_submitted_at as string|null) ?? null,
          has_id_front:nonempty(data.national_id_photo_path),
          has_id_back:nonempty(data.national_id_back_photo_path),
          has_selfie:nonempty(data.selfie_photo_path),
        };
      };
    } else {
      const sessionPortfolioId=await portfolioIdFromSession(admin,body.portfolioSession);
      if(sessionPortfolioId) {
        // OTP sessions are never staff: audience is a supporter seeing one portfolio.
        verifiedRoles=['supporter'];
        readPortfolios=async()=>{ const {data,error}=await admin.rpc('nexa_get_portfolio_by_id',{p_portfolio_id:sessionPortfolioId}); await auditPortfolioAccess(admin,'session_read',{portfolioId:sessionPortfolioId,ipHash:await sha256Hex(`ip:${ip}`)}); return error?{error:'Portfolio data is unavailable right now.'}:{portfolios:(data ?? []).map(normalizePortfolioRow)}; };
      }
    }
    // Learned knowledge is not deployed in this database; skip the missing-table read.
    const knowledge: [] = [];
    const key=Deno.env.get('LOVABLE_API_KEY'); if(!key) return json({error:'AI not configured'},503);
    const signupSafety = ' Never claim an inquiry creates an account, reveal whether a phone is registered, ask for a password/code in chat, or promise unverified bonuses. Signup requires consent and completion of the existing secure signup flow. A role preference never grants permissions.';
    const errorFor=(status:number)=>json({error:status===429?'Please try again shortly':status===402?'AI credits are unavailable. Check Plans & credits.':status===403?'AI access is blocked. Ask your workspace administrator to check access.':'AI temporarily unavailable'},status>=400&&status<500?status:503);
    // deno-lint-ignore no-explicit-any
    const convo:any[]=[{role:'system',content:buildNexaSystemPrompt(verifiedRoles,isStaff(verifiedRoles),publicRate)+signupSafety+knowledgeContext(knowledge ?? [])},...messages];
    const toolDefs=buildNexaToolDefs({publicRate,ownRate:!!readMyRate,ownProfile:!!readMyProfile});
    let finalText='';
    let toolBacked=false; // true once any server tool returned data this request
    for(let round=0;round<=MAX_TOOL_ROUNDS;round++) {
      const response=await fetch('https://ai.gateway.lovable.dev/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'google/gemini-3-flash-preview',messages:convo,tools:toolDefs,tool_choice:round===MAX_TOOL_ROUNDS?'none':'auto',stream:false})});
      if(!response.ok) return errorFor(response.status);
      const out=await response.json();
      const msg=out?.choices?.[0]?.message;
      const calls=Array.isArray(msg?.tool_calls)?msg.tool_calls.slice(0,4):[];
      if(!calls.length) { finalText=typeof msg?.content==='string'?msg.content:''; break; }
      convo.push({role:'assistant',content:msg.content ?? '',tool_calls:calls});
      for(const c of calls) {
        const result=await runNexaTool(String(c?.function?.name ?? ''),String(c?.function?.arguments ?? ''),readPortfolios,(tool,reason)=>recordAccessAlert(admin,{userId,phone:callerPhone,channel,roles:verifiedRoles,attemptedResource:tool,userMessage:question.content,reason}),{defaultRate:publicRate,readMyRate,readMyProfile});
        if(result && typeof result==='object' && !('error' in (result as Record<string,unknown>))) toolBacked=true;
        convo.push({role:'tool',tool_call_id:c.id,content:JSON.stringify(result)});
      }
    }
    if(!finalText.trim()) return errorFor(503);
    finalText=groundReply(finalText,toolBacked);
    return sse(finalText+(signup?pitch:''),signup);
  } catch { return json({error:'Unable to answer right now'},500); }
});


