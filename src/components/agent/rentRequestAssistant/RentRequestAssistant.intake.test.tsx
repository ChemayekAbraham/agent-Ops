import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
// One stable user object, as the real hook gives: a fresh object per render re-runs the assistant's [open, user] effect forever.
const auth = vi.hoisted(() => ({ user: { id: 'agent-1', user_metadata: { full_name: 'Agent One' } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useAgentCapacityMap', () => ({
  useAgentCapacityMap: () => ({ data: undefined, isLoading: false }),
  DAILY_ELIGIBILITY_THRESHOLD: 0.5,
}));
vi.mock('@/components/agent/rentRequestAssistant/useAssistantSpeech', () => ({
  useAssistantSpeech: () => ({ supported: false, enabled: false, speaking: false, failed: false, toggle: vi.fn(), stop: vi.fn(), replay: vi.fn() }),
}));
vi.mock('@/lib/rentAssistantRecordChecks', () => ({
  checkTenantPhone: vi.fn(async () => ({ status: 'free' })),
  checkNationalId: vi.fn(async () => ({ status: 'free' })),
  checkNewLc1Phone: vi.fn(async () => ({ status: 'free' })),
  loadAgentSelf: vi.fn(async () => ({ phone: null, nationalId: null })),
  maskPhone: (v: string) => v,
  maskNationalId: (v: string) => v,
}));
vi.mock('@/components/agent/LandlordSearchSelect', () => ({ LandlordSearchSelect: () => null }));
vi.mock('@/components/agent/RegisterLandlordDialog', () => ({ default: () => null }));
vi.mock('@/components/location/UgLocationPicker', () => ({ UgLocationPicker: () => null, default: () => null }));
vi.mock('@/components/agent/GuarantorConsentCheckbox', () => ({ GuarantorConsentCheckbox: () => null }));
vi.mock('@/components/agent/rentRequestAssistant/Lc1SearchStep', () => ({ Lc1SearchStep: () => null }));

import RentRequestAssistant from '@/components/agent/rentRequestAssistant/RentRequestAssistant';

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});

const answer = (text: string) => {
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};
const asked = (re: RegExp) => screen.findAllByText(re).then((els) => els[els.length - 1]);

/** Walks the chat to the family size question. */
async function reachFamilySize() {
  render(<RentRequestAssistant open onOpenChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /Weekly earner/ }));
  answer('300000');
  fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await asked(/What’s their phone number/);
  answer('0783123456');
  await asked(/What’s their full name/);
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'John' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Mukasa' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await asked(/Now the NIN/);
  answer('CM12345678ABCD');
  fireEvent.click(await screen.findByRole('button', { name: 'English' }));
  fireEvent.click(await screen.findByRole('button', { name: /Yes, a smartphone/ }));
  await asked(/How many people live in John’s household/);
}

describe('Rent request assistant: required intake', () => {
  it('will not move past family size until it is a number from 1 to 30', async () => {
    await reachFamilySize();
    answer('');
    expect(await screen.findByText(/how many people live in the household/i)).toBeInTheDocument();
    answer('0');
    expect(await screen.findByText(/between 1 and 30/)).toBeInTheDocument();
    answer('31');
    expect(await screen.findByText(/between 1 and 30/)).toBeInTheDocument();
    expect(screen.queryByText(/What work or business does John do/)).toBeNull();
    answer('4');
    expect(await asked(/What work or business does John do/)).toBeInTheDocument();
  });

  it('will not move past work until it has 3+ characters; work location can be skipped', async () => {
    await reachFamilySize();
    answer('4');
    await asked(/What work or business does John do/);
    answer('ab');
    expect(await screen.findByText(/at least 3 letters/)).toBeInTheDocument();
    expect(screen.queryByText(/Where do they work/)).toBeNull();
    answer('Tailor');
    await asked(/Where do they work/);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(screen.getByText('No work location')).toBeInTheDocument());
    expect(screen.getByText('4 people')).toBeInTheDocument();
    expect(screen.getByText('Tailor')).toBeInTheDocument();
  });
});
