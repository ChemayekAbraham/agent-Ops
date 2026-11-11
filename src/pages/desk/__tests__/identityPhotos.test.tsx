import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E77: identity photos at the top of every desk's review drawer, the flag banner, and the system concern on the COO board. */

const h = vi.hoisted(() => ({ rpc: vi.fn(), sign: vi.fn() }));
const fromChain = { select: () => fromChain, eq: () => fromChain, in: () => fromChain, order: () => Promise.resolve({ data: [], error: null }) };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: () => fromChain,
    storage: { from: (bucket: string) => ({ createSignedUrl: (path: string) => h.sign(bucket, path) }) },
  },
}));
vi.mock('@/hooks/useIdentityPhotos', () => ({ identityPhotoUrl: async (p: string | null) => (p ? `https://signed/identity/${p}` : null) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({
  useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }),
  useCooReasonCodes: () => ({ data: [], isLoading: false }),
}));

import { FLAG_WORDS, IdentityPanel, identityBanner } from '../identityPhotos';
import { ReviewDrawer } from '../ReviewDrawer';
import { ReviewStatusProvider } from '../reviewStatus';
import { CONCERN_BLOCK_LINE, CooBoard, cooLines, type CooRow } from '../CooBoard';
import type { Stage } from '../reviewTypes';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));

const PHOTOS = {
  tenant: {
    name: 'Odenyo Elly', passport_photo_url: 'https://cdn.example/tenant.jpg',
    id_front: { bucket: 'tenant-ids', path: 'r1/front.jpg' }, id_back: { bucket: 'tenant-ids', path: 'r1/back.jpg' },
  },
  agent: { name: 'Andy Agent', photo_url: 'https://cdn.example/agent-avatar.jpg', vetting_passport_photo: 'a1/passport.jpg', vetting_status: 'approved' },
  flags: { tenant_photo_is_agent_profile_photo: false, tenant_photo_matches_agent_fingerprint: false, tenant_photo_used_by_another_person: false },
};

const SHEET = (stage: Stage) => ({
  request: {
    id: 'r1', status: 'x', stage, round: 0, rent_amount: 700000, duration_days: 30, created_at: '2026-11-01',
    tenant: { id: 't1', name: 'Odenyo Elly', phone: null, occupation: null }, agent: { id: 'a1', name: 'Andy Agent', phone: null },
    landlord: { id: 'l1', name: 'Lucy', phone: null, verified: true }, lc1: null, lc_letter: null, house_photos: [], gps: null, funder_visible: true,
  },
  checklist: [], history: [], score: null, recommendation: null, can_review: true, my_staff_ref: 'E',
});

function serve(stage: Stage, photos: unknown = PHOTOS, photosError?: { message: string }) {
  h.rpc.mockReset();
  h.rpc.mockImplementation((fn: string) => {
    if (fn === 'request_identity_photos') return Promise.resolve(photosError ? { data: null, error: photosError } : { data: photos, error: null });
    if (fn === 'pipeline_review_sheet') return Promise.resolve({ data: SHEET(stage), error: null });
    if (/_list$|_calls$|waiting_list|concerns/.test(fn)) return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

beforeEach(() => {
  h.sign.mockReset();
  h.sign.mockImplementation((bucket: string, path: string) => Promise.resolve({ data: { signedUrl: `https://signed/${bucket}/${path}` }, error: null }));
});

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReviewStatusProvider>{ui}</ReviewStatusProvider>
    </QueryClientProvider>,
  );

describe('the banner words', () => {
  it('nothing raised, no banner; each flag in plain words', () => {
    expect(identityBanner(PHOTOS.flags)).toBeNull();
    expect(identityBanner({})).toBeNull();
    expect(identityBanner({ tenant_photo_used_by_another_person: true })).toBe(`Check identity: ${FLAG_WORDS.tenant_photo_used_by_another_person}`);
    expect(identityBanner({ tenant_photo_is_agent_profile_photo: true, tenant_photo_matches_agent_fingerprint: true })).toBe(
      `Check identity: ${FLAG_WORDS.tenant_photo_is_agent_profile_photo}; ${FLAG_WORDS.tenant_photo_matches_agent_fingerprint}`,
    );
  });
});

describe('the identity panel', () => {
  it('tenant and agent side by side, ID front and back signed from their bucket; tap to enlarge', async () => {
    serve('agent_ops');
    wrap(<IdentityPanel requestId="r1" />);
    const tenant = (await screen.findByRole('img', { name: 'Tenant passport photo: Odenyo Elly' })) as HTMLImageElement;
    expect(tenant.src).toBe('https://cdn.example/tenant.jpg');
    // The vetting passport photo wins over the profile picture.
    expect((screen.getByRole('img', { name: 'Agent photo: Andy Agent' }) as HTMLImageElement).src).toBe('https://signed/identity/a1/passport.jpg');
    expect((screen.getByRole('img', { name: 'Tenant ID, front' }) as HTMLImageElement).src).toBe('https://signed/tenant-ids/r1/front.jpg');
    expect((screen.getByRole('img', { name: 'Tenant ID, back' }) as HTMLImageElement).src).toBe('https://signed/tenant-ids/r1/back.jpg');
    expect(h.sign).toHaveBeenCalledWith('tenant-ids', 'r1/front.jpg');
    expect(screen.getByText('Agent · vetting approved')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Enlarge: Tenant passport photo: Odenyo Elly' }));
    const big = screen.getByRole('dialog', { name: 'Tenant passport photo: Odenyo Elly' });
    expect((within(big).getByRole('img') as HTMLImageElement).src).toBe('https://cdn.example/tenant.jpg');
    fireEvent.click(within(big).getByRole('button', { name: 'Close the photo' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('missing pictures say so; a refusal is shown as-is', async () => {
    serve('agent_ops', { tenant: { name: 'T', passport_photo_url: null, id_front: null, id_back: null }, agent: { name: 'A', photo_url: null, vetting_passport_photo: null, vetting_status: null }, flags: {} });
    const { unmount } = wrap(<IdentityPanel requestId="r1" />);
    expect((await screen.findAllByText('No photo')).length).toBe(4);
    unmount();
    serve('agent_ops', PHOTOS, { message: 'Only desk reviewers can see identity photos' });
    wrap(<IdentityPanel requestId="r1" />);
    expect((await screen.findByRole('alert')).textContent).toBe('Only desk reviewers can see identity photos');
  });
});

describe('in the review drawer at every desk', () => {
  const STAGES: Stage[] = ['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo'];

  it.each(STAGES)('%s: photos at the top; no banner while nothing is raised', async (stage) => {
    setWidth(1280);
    serve(stage);
    wrap(<ReviewDrawer stage={stage} requestId="r1" onClose={() => {}} />);
    const panel = await screen.findByRole('region', { name: 'Identity photos' });
    await within(panel).findByRole('img', { name: /Tenant passport photo/ });
    const facts = screen.getByText('What the agent sent');
    expect(panel.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('[data-identity-banner]')).toBeNull();
  });

  it('a raised flag puts the red banner above the decision buttons', async () => {
    setWidth(1280);
    serve('landlord_ops', { ...PHOTOS, flags: { ...PHOTOS.flags, tenant_photo_matches_agent_fingerprint: true } });
    wrap(<ReviewDrawer stage="landlord_ops" requestId="r1" onClose={() => {}} />);
    const banner = await screen.findByText(`Check identity: ${FLAG_WORDS.tenant_photo_matches_agent_fingerprint}`);
    const decision = screen.getByRole('heading', { name: 'Your decision' }).closest('section') as HTMLElement;
    expect(decision.contains(banner)).toBe(true);
    const firstButton = within(decision).getAllByRole('button')[0];
    expect(banner.compareDocumentPosition(firstButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('COO board: the system (E77) concern, as written', () => {
  const NOTE = "System (E77): The tenant's passport photo is the same picture as the agent's own photo. Check the tenant in person before passing.";
  const coo = (over: Partial<CooRow>): CooRow => ({
    id: 'c1', req: 'c1', tenant: 'Cara', agent: 'Andy', agent_grade: 'B', landlord: 'L', landlord_verified: true, rent: 300000, days_here: 4.4,
    ratings: { agent_ops: 80, tenant_ops: null, landlord_ops: 60, average: 70, grade: 'B', partly_rated: false }, grade: 'A', avg: 80,
    flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: false, frozen: null, concern_block: true, ...over,
  });

  it('a blocked row carries the system note word for word; a person’s note is not repeated', () => {
    expect(cooLines(coo({}), { open: 1, serious: 1, latest: NOTE })).toEqual([CONCERN_BLOCK_LINE, NOTE]);
    expect(cooLines(coo({}), { open: 1, serious: 1, latest: 'Landlord sounded unsure' })).toEqual([CONCERN_BLOCK_LINE]);
    expect(cooLines(coo({ concern_block: false }), { open: 1, serious: 1, latest: NOTE })).toEqual([]);
  });

  it('on the board, with no push button', async () => {
    setWidth(1280);
    h.rpc.mockReset();
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'pipeline_coo_board'
          ? { data: { counts: {}, can_push: true, rows: [coo({})] }, error: null }
          : fn === 'pipeline_concerns_summary'
            ? { data: { c1: { open: 1, serious: 1, latest: NOTE } }, error: null }
            : { data: null, error: null },
      ),
    );
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    expect(await screen.findByText(NOTE)).toBeTruthy();
    const row = document.querySelector('[data-row="c1"]') as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'Push to funders' })).toBeNull();
  });
});
