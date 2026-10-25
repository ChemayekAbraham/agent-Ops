import { afterEach,describe,it,expect,vi } from 'vitest';
import { sendWhatsApp } from '../../supabase/functions/_shared/whatsapp';
const secrets:Record<string,string>={META_WHATSAPP_ACCESS_TOKEN:'TEST_META_TOKEN',META_WHATSAPP_PHONE_NUMBER_ID:'12345',META_WHATSAPP_FALLBACK_TEMPLATE:'test_template',TWILIO_ACCOUNT_SID:'TEST_SID',TWILIO_AUTH_TOKEN:'TEST_TOKEN',TWILIO_WHATSAPP_FROM:'+10000000000'};
const configure=()=>vi.stubGlobal('Deno',{env:{get:(key:string)=>secrets[key]}});
afterEach(()=>vi.unstubAllGlobals());
describe('Meta primary and safe WhatsApp fallback',()=>{
  it('uses Meta first without calling Twilio on accepted delivery',async()=>{
    configure();const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({messages:[{id:'TEST_ID'}]}),{status:200}));vi.stubGlobal('fetch',fetcher);
    expect((await sendWhatsApp('+10000000001','TEST_BODY')).provider).toBe('meta');expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses the approved template only after a definitive 24-hour-window rejection',async()=>{
    configure();const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:131047}}),{status:400})).mockResolvedValueOnce(new Response(JSON.stringify({messages:[{id:'TEST_ID'}]}),{status:200}));vi.stubGlobal('fetch',fetcher);
    expect((await sendWhatsApp('+10000000001','TEST_BODY')).ok).toBe(true);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).type).toBe('template');expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('falls back to Twilio after definite Meta rejection',async()=>{
    configure();const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:100}}),{status:400})).mockResolvedValueOnce(new Response(JSON.stringify({sid:'TEST_ID'}),{status:200}));vi.stubGlobal('fetch',fetcher);
    expect((await sendWhatsApp('+10000000001','TEST_BODY')).provider).toBe('twilio');expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never duplicates a send after uncertain Meta delivery',async()=>{
    configure();const fetcher=vi.fn().mockRejectedValue(new Error('TEST_NETWORK_FAILURE'));vi.stubGlobal('fetch',fetcher);
    expect((await sendWhatsApp('+10000000001','TEST_BODY')).error).toBe('meta_delivery_unknown');expect(fetcher).toHaveBeenCalledTimes(1);
  });
});