import { describe,it,expect } from 'vitest';
import { verifyMetaSignature } from '../../supabase/functions/whatsapp-webhook/security';
describe('Meta webhook signature gate',()=>{
  it('accepts the exact signed body and rejects missing, wrong and tampered signatures',async()=>{
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('TEST_SECRET'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const body='{"object":"TEST_EVENT"}';
    const signed=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body)));
    const signature='sha256='+Array.from(signed,b=>b.toString(16).padStart(2,'0')).join('');
    expect(await verifyMetaSignature(body,signature,'TEST_SECRET')).toBe(true);
    expect(await verifyMetaSignature(body+' ',signature,'TEST_SECRET')).toBe(false);
    expect(await verifyMetaSignature(body,signature,'WRONG_TEST_SECRET')).toBe(false);
    expect(await verifyMetaSignature(body,null,'TEST_SECRET')).toBe(false);
  });
});