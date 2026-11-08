import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildNexaPublicGuideReply, isFinancialAccessQuery, toAuthGatedUrl } from '../_shared/nexaGuides.ts';
import { extractInquiryLeadDetails, buildSignupPersuasionPitch } from '../_shared/nexaSignup.ts';
import { sendWhatsApp } from '../_shared/whatsapp.ts';
import { buildNexaSystemPrompt, wantsHuman, knowledgeContext, isRestrictedInternalStaffQuery, buildInternalStaffRefusalReply } from '../_shared/nexa.ts';
import { recordAccessAlert } from '../_shared/nexaAccess.ts';
import { cachedPublicPolicy } from '../_shared/partnerReturnPolicy.ts';
import { verifyMetaSignature } from './security.ts';
import { buildWhatsAppAiReply } from './ai.ts';
const corsHeaders = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'content-type, x-hub-signature-256' };
const reply = (text:string,status=200) => new Response(text,{status,headers:corsHeaders});
// Warm-instance bounded cache; provider ID is also persisted for escalation deduplication.
const seen = new Map<string,number>();
const rates = new Map<string,{count:number;at:number}>();
Deno.serve(async req => {
  if(req.method==='OPTIONS') return reply('ok');
  const verifyToken=Deno.env.get('META_WHATSAPP_VERIFY_TOKEN');
  if(req.method==='GET') {
    const url=new URL(req.url);
    if(verifyToken && url.searchParams.get('hub.mode')==='subscribe' && url.searchParams.get('hub.verify_token')===verifyToken) return reply(url.searchParams.get('hub.challenge') ?? '');
    return reply('Forbidden',403);
  }
  if(req.method!=='POST') return reply('Method not allowed',405);
  const secret=Deno.env.get('META_WHATSAPP_APP_SECRET');
  if(!secret) return reply('Webhook not configured',503);
  const raw=await req.text(); if(raw.length>1000000) return reply('Too large',413);
  if(!await verifyMetaSignature(raw,req.headers.get('x-hub-signature-256'),secret)) return reply('Forbidden',403);
  try {
    const payload=JSON.parse(raw);
    if(payload.object!=='whatsapp_business_account' || !Array.isArray(payload.entry)) return reply('Invalid event',400);
    const url=Deno.env.get('SUPABASE_URL'), key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if(!url || !key) return reply('Service unavailable',503);
    const admin=createClient(url,key);
    // PUBLIC new-partner rate only (a phone number is not an identity): read once per inbound
    // webhook call, lazily, from the 60 s isolate cache. null = unknown -> replies give no figure.
    let publicRateRead:Promise<number|null>|null=null;
    const publicRate=()=>publicRateRead ??= cachedPublicPolicy(admin).then(p=>p?.newContractRate ?? null);
    for(const entry of payload.entry.slice(0,10)) for(const change of (entry.changes ?? []).slice(0,10)) {
      if(change.field!=='messages') continue;
      if(change.value?.metadata?.phone_number_id!==Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID')) continue;
      for(const msg of (change.value?.messages ?? []).slice(0,20)) {
        if(msg.type!=='text' || typeof msg.text?.body!=='string' || msg.text.body.length>4000 || !/^\d{8,15}$/.test(msg.from) || typeof msg.id!=='string' || msg.id.length>255) continue;
        const now=Date.now();
        for(const [id,at] of seen) if(now-at>86400000) seen.delete(id);
        if(seen.has(msg.id)) continue;
        const rate=rates.get(msg.from);
        if(rate && now-rate.at<60000 && rate.count>=8) continue;
        if(!rate || now-rate.at>=60000) rates.set(msg.from,{count:1,at:now}); else rate.count++;
        const text=msg.text.body;
        // A WhatsApp number is a contact channel, NOT an authenticated app identity.
        // Never attach private in-app data based on a phone match alone.
        let answer:string;
        const returnsRate = await publicRate();
        const guide = buildNexaPublicGuideReply(text, false, returnsRate);
        if(isRestrictedInternalStaffQuery(text)) {
          await recordAccessAlert(admin,{userId:null,phone:`+${msg.from}`,channel:'whatsapp',roles:[],attemptedResource:'internal_staff_query',userMessage:text,reason:'Non-staff caller asked for internal staff-only information'});
          answer=buildInternalStaffRefusalReply();
        } else if(guide) {
          answer=guide;
        } else if(wantsHuman(text)) {
          const {error}=await admin.from('nexa_human_escalations').insert({user_id:null,user_phone:`+${msg.from}`,user_role:'whatsapp_contact',user_question:text,conversation_context:[],provider_message_id:msg.id});
          if(error?.code==='23505') {seen.set(msg.id,now);continue;}
          if(error) return reply('Escalation unavailable',503);
          answer=`Your question has been sent to Benjamin’s Desk. Sign in at ${toAuthGatedUrl('/dashboard')} to send and receive private account questions. Welile support: https://wa.me/256777607640`;
        } else {
          const {data:knowledge}=await admin.from('nexa_learned_knowledge').select('topic,question_pattern,canonical_answer').eq('active',true).eq('role_scope','all').limit(20);
          const aiKey=Deno.env.get('LOVABLE_API_KEY'); if(!aiKey) return reply('AI unavailable',503);
          answer=await buildWhatsAppAiReply(aiKey,buildNexaSystemPrompt([], false, returnsRate)+' Never claim a phone inquiry creates an account or proves ownership. Never supply passwords, reveal account existence or promise unverified signup bonuses. Use the secure consent-based signup flow.'+knowledgeContext(knowledge ?? []),text,req.signal);
        }
        if (!isRestrictedInternalStaffQuery(text) && !isFinancialAccessQuery(text)) {
          const lead = extractInquiryLeadDetails(text, {leadPhone:msg.from});
          answer += `\n\n${buildSignupPersuasionPitch(lead.role, !!lead.fullPhone, returnsRate)}`;
        }
        const sent=await sendWhatsApp(msg.from,answer);
        // On unknown delivery do not retry the same provider event and duplicate messages.
        if(sent.ok || sent.error?.endsWith('delivery_unknown')) seen.set(msg.id,now);
        else return reply('Delivery unavailable',503);
      }
    }
    return reply('EVENT_RECEIVED');
  } catch { return reply('Unable to process event',500); }
});