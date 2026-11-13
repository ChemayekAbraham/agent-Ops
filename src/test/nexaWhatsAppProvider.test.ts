import { afterEach,describe,it,expect,vi } from 'vitest';
import { sendWhatsApp } from '../../supabase/functions/_shared/whatsapp';
const secrets:Record<string,string>={META_WHATSAPP_ACCESS_TOKEN:'TEST_META_TOKEN',META_WHATSAPP_PHONE_NUMBER_ID:'12345',META_WHATSAPP_FALLBACK_TEMPLATE:'test_template'};
const configure=()=>vi.stubGlobal('Deno',{env:{get:(key:string)=>secrets[key]}});
afterEach(()=>vi.unstubAllGlobals());
describe('Meta-only WhatsApp delivery',()=>{
  it('sends through Meta on accepted delivery',async()=>{
    configure();const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({messages:[{id:'TEST_ID'}]}),{status:200}));vi.stubGlobal('fetch',fetcher);
    expect((await sendWhatsApp('+10000000001','TEST_BODY')).provider).toBe('meta');expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sends an explicitly requested template without a free-form attempt',async()=>{
    configure();const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({messages:[{id:'TEST_ID'}]}),{status:200}));vi.stubGlobal('fetch',fetcher);
    await sendWhatsApp('+256700000001','TEST_BODY',{templateName:'test_template',templateParameters:['TEST_VALUE']});
    const payload=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload.type).toBe('template');expect(payload.to).toBe('256700000001');expect(payload.template.components[0].parameters[0].text).toBe('TEST_VALUE');expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses the approved template only after a definitive 24-hour-window rejection',async()=>{
    configure();const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:131047}}),{status:400})).mockResolvedValueOnce(new Response(JSON.stringify({messages:[{id:'TEST_ID'}]}),{status:200}));vi.stubGlobal('fetch',fetcher);
    expect((await sendWhatsApp('+10000000001','TEST_BODY')).ok).toBe(true);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).type).toBe('template');expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('returns the Meta rejection with no second provider',async()=>{
    configure();const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:100}}),{status:400}));vi.stubGlobal('fetch',fetcher);
    const r=await sendWhatsApp('+10000000001','TEST_BODY');expect(r.ok).toBe(false);expect(r.error).toBe('meta_rejected_100');expect(r.provider).toBe('meta');expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('never duplicates a send after uncertain Meta delivery',async()=>{
    configure();const fetcher=vi.fn().mockRejectedValue(new Error('TEST_NETWORK_FAILURE'));vi.stubGlobal('fetch',fetcher);
    expect((await sendWhatsApp('+10000000001','TEST_BODY')).error).toBe('meta_delivery_unknown');expect(fetcher).toHaveBeenCalledTimes(1);
  });
});