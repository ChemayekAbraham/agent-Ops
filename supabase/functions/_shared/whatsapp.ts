/** WhatsApp delivery via the Meta Cloud API only. No message bodies in logs. */
export function toE164(phone:string|null|undefined):string|null {
  let p=(phone ?? '').replace(/[^0-9]/g,'');
  if(/^0\d{9}$/.test(p)) p='256'+p.slice(1);
  else if(/^\d{9}$/.test(p)) p='256'+p;
  return /^[1-9]\d{7,14}$/.test(p)?'+'+p:null;
}
export function toMetaRecipient(phone:string|null|undefined):string|null { return toE164(phone)?.slice(1) ?? null; }
export interface WhatsAppResult {ok:boolean; skipped?:boolean; error?:string|null; sid?:string|null; provider?:'meta'}
export interface WhatsAppOptions {contentVariables?:Record<string,string>; templateName?:string; templateLanguage?:string; templateParameters?:string[]}
export async function sendViaMetaCloudApi(phone:string,body:string,opts?:WhatsAppOptions):Promise<WhatsAppResult> {
  const token=Deno.env.get('META_WHATSAPP_ACCESS_TOKEN'), id=Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID');
  if(!token || !id) return {ok:false,skipped:true,error:'meta_not_configured'};
  if(!/^\d+$/.test(id)) return {ok:false,error:'invalid_meta_sender'};
  const to=toMetaRecipient(phone); if(!to) return {ok:false,error:'invalid_phone'};
  async function send(payload:unknown) {
    const response=await fetch(`https://graph.facebook.com/v21.0/${id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
    const data=await response.json().catch(()=>({}));
    return {response,data};
  }
  try {
    const templatePayload = (name:string) => {
      const parameters=opts?.templateParameters ?? Object.values(opts?.contentVariables ?? {});
      return {messaging_product:'whatsapp',to,type:'template',template:{name,language:{code:opts?.templateLanguage ?? Deno.env.get('META_WHATSAPP_TEMPLATE_LANGUAGE') ?? 'en'},...(parameters.length?{components:[{type:'body',parameters:parameters.map(text=>({type:'text',text}))}]}:{})}};
    };
    let result=await send(opts?.templateName ? templatePayload(opts.templateName) : {messaging_product:'whatsapp',to,type:'text',text:{preview_url:true,body}});
    // Only a definitive closed-service-window rejection warrants a template send.
    if(!opts?.templateName && !result.response.ok && Number(result.data.error?.code)===131047) {
      const name=opts?.templateName ?? Deno.env.get('META_WHATSAPP_FALLBACK_TEMPLATE');
      if(!name) return {ok:false,error:'meta_template_required'};
      result=await send(templatePayload(name));
    }
    if(!result.response.ok) return {ok:false,error:`meta_rejected_${result.data.error?.code ?? result.response.status}`,provider:'meta'};
    return {ok:true,sid:result.data.messages?.[0]?.id ?? null,provider:'meta'};
  } catch { return {ok:false,error:'meta_delivery_unknown',provider:'meta'}; }
}
export async function sendWhatsApp(phone:string|null|undefined,body:string,opts?:WhatsAppOptions):Promise<WhatsAppResult> {
  const to=toE164(phone);if(!to)return {ok:false,skipped:true,error:'no_phone'};
  if(!body.trim() || body.length>4096)return {ok:false,error:'invalid_message'};
  return sendViaMetaCloudApi(to,body,opts);
}
