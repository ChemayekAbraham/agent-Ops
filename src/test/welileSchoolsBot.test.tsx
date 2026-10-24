import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SchoolRow } from '@/lib/welileSchools';
import { SchoolRegistration } from '@/pages/agent/AgentWelileSchools';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/location/UgLocationPicker', () => ({ default: ({ onChange }: { onChange: (value: unknown) => void }) => <button onClick={() => onChange({ region: 'Central', district: 'Test district', subcounty: 'Test division', parish: 'Test parish', village: 'Test village', county: 'Test city', fullPath: 'Test path' })}>Choose test location</button> }));
vi.mock('@/components/ui/country-combobox', () => ({ CountryCombobox: () => <div>Country selector</div> }));

afterEach(cleanup);

function setup() {
  const save = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState<Partial<SchoolRow>>({ country: 'Uganda', gate_name: 'Main Gate', school_level: 'Primary', ownership: 'Government' });
    return <SchoolRegistration draft={draft} setDraft={setDraft} captureGps={async () => false} gpsBusy={false} saving={false} onSave={() => save(draft)} onCancel={() => undefined} />;
  }
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  render(<Harness />);
  return { user: userEvent.setup(), save };
}

describe('School bot draft flow', () => {
  it('preserves mapped location, Mixed / K-12 and edited school name when saving', async () => {
    const { user, save } = setup();
    await user.type(screen.getByRole('textbox', { name: 'School name' }), 'Example Test School');
    await user.click(screen.getByRole('button', { name: 'Send school name' }));
    await user.click(screen.getByRole('button', { name: 'Mixed / K-12' }));
    await user.click(screen.getByRole('button', { name: 'Continue', exact: true }));
    await user.click(screen.getByRole('button', { name: 'Skip GPS for now' }));
    await user.click(screen.getByRole('button', { name: 'Choose test location' }));
    await user.click(screen.getByRole('button', { name: 'Confirm Location' }));
    await user.click(screen.getByRole('button', { name: 'Skip for now', exact: true }));
    await user.click(screen.getByRole('button', { name: 'Edit step 1' }));
    await user.clear(screen.getByRole('textbox', { name: 'School name' }));
    await user.type(screen.getByRole('textbox', { name: 'School name' }), 'Updated Test School');
    await user.click(screen.getByRole('button', { name: 'Send school name' }));
    await user.click(screen.getByRole('button', { name: 'Classic Form' }));
    await user.click(screen.getByRole('button', { name: 'Register School & Lock Gate' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Updated Test School', school_level: 'Mixed / K-12', country: 'Uganda', region: 'Central', district: 'Test district', sub_county: 'Test division', parish: 'Test parish', village: 'Test village', town: 'Test city', latitude: null, longitude: null }));
  });
  it('Start Over clears previous answers and restores Main Gate defaults', async () => {
    const { user, save } = setup();
    await user.type(screen.getByRole('textbox', { name: 'School name' }), 'Discarded Test School');
    await user.click(screen.getByRole('button', { name: 'Start Over' }));
    await user.click(screen.getByRole('button', { name: 'Classic Form' }));
    await user.click(screen.getByRole('button', { name: 'Register School & Lock Gate' }));
    expect(save).toHaveBeenCalledWith({ country: 'Uganda', school_level: 'Primary', ownership: 'Government', gate_name: 'Main Gate' });
  });
});