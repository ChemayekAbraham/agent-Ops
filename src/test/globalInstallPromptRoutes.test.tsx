import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import GlobalInstallPrompt from '@/components/GlobalInstallPrompt';

vi.mock('@/components/InstallNagOverlay', () => ({
  default: () => <div role="dialog" />,
}));

describe('global install offer route eligibility', () => {
  it('never mounts the install offer on a co-support invitation', () => {
    render(<MemoryRouter initialEntries={['/co-support/AB12CD34EF56']}><GlobalInstallPrompt /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the install offer available on other public pages', () => {
    render(<MemoryRouter initialEntries={['/schools']}><GlobalInstallPrompt /></MemoryRouter>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});