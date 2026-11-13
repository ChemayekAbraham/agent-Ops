/**
 * Send time on the latency model (src/test/sendLatencySim.ts): measured server times, an
 * assumed 300 ms phone round trip, and a shared uplink of 1 Mbit/s (slow 3G) or 5 Mbit/s (4G).
 * Before this change the same model gave, at 1 Mbit/s, 16.9 s for a new request and 11.6 s
 * for a resubmit (run on the old code); at 5 Mbit/s 10.5 s and 5.8 s (the same sequential
 * sum with the faster uplink).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ sim: null as null | ReturnType<typeof import('@/test/sendLatencySim').createLatencySim> }));
vi.mock('@/integrations/supabase/client', async () => {
  const m = await import('@/test/sendLatencySim');
  holder.sim = m.createLatencySim();
  return { supabase: holder.sim.supabase };
});
vi.mock('@/lib/imageOptimizer', () => ({ optimizeImage: async (file: File) => ({ file }) }));
vi.mock('@/lib/archiveToDrive', () => ({ archiveToDrive: vi.fn() }));
vi.mock('@/lib/avatarSync', () => ({ publishAvatarUpdate: vi.fn() }));
vi.mock('@/lib/agentSignupTelemetry', () => ({ collectAgentSignupTelemetry: vi.fn(async () => ({})) }));
vi.mock('@/lib/getPublicOrigin', () => ({ getPublicOrigin: () => 'https://welile.test' }));

import { LATENCY, SIZES, sizedFile } from '@/test/sendLatencySim';
import { supabase } from '@/integrations/supabase/client';
import { submitAssistantRentRequest } from '@/lib/rentRequestAssistantSubmit';
import { resubmitT4Request, uploadNewRequestDocs } from '@/lib/t4RentRequestSubmit';
import { createUploadCounter, sendButtonLabel, type SendProgress } from '@/lib/sendProgress';

const sim = () => holder.sim!;
const house = () => [0, 1, 2, 3].map((i) => sizedFile(SIZES.housePhoto, `h${i}.jpg`));
const UPLINKS = [
  { name: '1 Mbit/s', bytesPerMs: 125, before: { newRequest: 16_860, resubmit: 11_560 } },
  { name: '5 Mbit/s', bytesPerMs: 625, before: { newRequest: 10_450, resubmit: 5_790 } },
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  sim().calls.length = 0;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); LATENCY.uplinkBytesPerMs = 125; });

const firstAt = (prefix: string) => sim().calls.find((c) => c.name.startsWith(prefix))?.at ?? Infinity;
const lastAt = (prefix: string) => Math.max(...sim().calls.filter((c) => c.name.startsWith(prefix)).map((c) => c.at));

describe.each(UPLINKS)('new request (T4 form), uplink $name', ({ name, bytesPerMs, before }) => {
  it('uploads every photo side by side, then inserts once, and is faster than before', async () => {
    LATENCY.uplinkBytesPerMs = bytesPerMs;
    const seen: SendProgress[] = [];
    const { ms, value } = await sim().time(async () => {
      // As the form does: the documents start uploading, then the phone / NIN re-check.
      const counter = createUploadCounter((p) => seen.push(p));
      const docs = uploadNewRequestDocs('agent-1', {
        idFront: sizedFile(SIZES.idPhoto, 'f.jpg'), idBack: sizedFile(SIZES.idPhoto, 'b.jpg'), lcLetter: sizedFile(SIZES.lcLetter, 'l.jpg'),
      }, counter);
      await Promise.all([supabase.rpc('check_phone_exists' as never), supabase.rpc('check_phone_exists' as never)]);
      return submitAssistantRentRequest({
        agentId: 'agent-1', docs, uploadCounter: counter, incomeType: 'daily', earnerCycle: 'weekly',
        fees: { rentAmount: 300000, durationDays: 30, accessFee: 1, requestFee: 1, totalRepayment: 300002, dailyRepayment: 10000 },
        tenantName: 'John Mukasa', tenantPhone: '0783123456', tenantNationalId: 'CM12345678ABCD', preferredLanguage: 'English', noSmartphone: false,
        landlordId: 'landlord-1', landlordName: 'Grace Namata', landlordPhone: '0772000222', house: null, houseCategory: 'single-room',
        propertyCity: '', propertyDistrict: '', location: null, gps: null, housePhotos: house(),
        tenantPhoto: sizedFile(SIZES.tenantPhoto, 't.jpg'), faceCheckSha256: 'abc',
        lc1Name: 'Peter Okello', lc1Phone: '0772000111', lc1Village: 'Kireka B', lcLetter: null, landlordPayoutDay: '5',
        familySize: 4, workBusiness: 'Tailor', workLocation: 'Owino', noLc1Reason: null,
      });
    });
    expect(value.ok).toBe(true);
    console.log(`[send-timing model] new request @ ${name}: before ${before.newRequest} ms, after ${ms} ms`);
    expect(ms).toBeLessThan(before.newRequest * 0.75);

    // All 8 uploads (3 documents, passport, 4 house photos) start within the re-check, before the insert.
    const uploads = sim().calls.filter((c) => c.name.startsWith('upload:'));
    expect(uploads).toHaveLength(8);
    expect(lastAt('upload:') - uploads[0].at).toBeLessThanOrEqual(LATENCY.rttMs + LATENCY.rpcMs + 10);
    expect(lastAt('upload:')).toBeLessThan(firstAt('insert:rent_requests'));
    // The house photos are in the insert: no update afterwards for them.
    expect(sim().calls.filter((c) => c.name === 'update:rent_requests')).toHaveLength(0);
    // The re-check and the submit's checks run while the photos upload.
    expect(firstAt('rpc:check_phone_exists')).toBe(uploads[0].at);
    expect(firstAt('rpc:get_landlord_verification_status')).toBeLessThan(lastAt('upload:') + 1);

    // The invite SMS is fired, never waited for (the model gives it 5.5 s).
    expect(sim().calls.some((c) => c.name === 'fn:send-signup-invite-sms')).toBe(true);
    // Notices and the assistant are not on the send path.
    expect(sim().calls.some((c) => /tenant-rent-intake-notices|agent-assistant/.test(c.name))).toBe(false);

    // The button counts every photo, then says Saving….
    const labels = seen.map((p) => sendButtonLabel(p, ''));
    expect(labels).toContain('Uploading photos 0/8…');
    expect(labels).toContain('Uploading photos 7/8…');
    expect(labels.at(-1)).toBe('Saving…');
  });
});

describe.each(UPLINKS)('resubmit, uplink $name', ({ name, bytesPerMs, before }) => {
  it('saves the details, attaches the documents and uploads the house photos side by side, then resubmits', async () => {
    LATENCY.uplinkBytesPerMs = bytesPerMs;
    const seen: SendProgress[] = [];
    const { ms, value } = await sim().time(() => resubmitT4Request({
      agentId: 'agent-1', requestId: 'req-9', patch: {}, note: 'Fixed', photos: house(), extraPhotoUrls: [], lcLetter: null, noLc1Reason: null,
      details: { familySize: 4, workBusiness: 'Tailor', workLocation: null },
      docs: { id_front: sizedFile(SIZES.idPhoto, 'f.jpg'), id_back: sizedFile(SIZES.idPhoto, 'b.jpg'), lc1_letter: sizedFile(SIZES.lcLetter, 'l.jpg') },
      onProgress: (p) => seen.push(p),
    }));
    expect(value.ok).toBe(true);
    console.log(`[send-timing model] resubmit @ ${name}: before ${before.resubmit} ms, after ${ms} ms`);
    expect(ms).toBeLessThan(before.resubmit * 0.8);

    const uploads = sim().calls.filter((c) => c.name.startsWith('upload:'));
    expect(uploads).toHaveLength(7);
    expect(new Set(uploads.map((u) => u.at)).size).toBe(1);
    expect(firstAt('rpc:agent_save_intake_details')).toBe(uploads[0].at);
    // E90: everything is in before the server is asked to take the request back.
    expect(lastAt('rpc:request_attach_document')).toBeLessThan(firstAt('rpc:agent_resubmit_rent_request'));
    expect(lastAt('rpc:agent_save_intake_details')).toBeLessThan(firstAt('rpc:agent_resubmit_rent_request'));
    expect(sim().calls.filter((c) => c.name === 'rpc:request_attach_document')).toHaveLength(3);

    const labels = seen.map((p) => sendButtonLabel(p, ''));
    expect(labels).toContain('Uploading photos 0/7…');
    expect(labels.at(-1)).toBe('Saving…');
  });
});
