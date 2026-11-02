import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerifiedAvatarRing } from './VerifiedAvatarRing';

describe('VerifiedAvatarRing', () => {
  it('shows no ring or badge when state is null', () => {
    const { container } = render(<VerifiedAvatarRing state={null}><img alt="a" /></VerifiedAvatarRing>);
    expect(container.querySelector('[data-verified-state]')).toBeNull();
  });
  it('labels a verified agent', () => {
    render(<VerifiedAvatarRing state="verified"><img alt="a" /></VerifiedAvatarRing>);
    expect(screen.getByText('Verified agent')).toBeTruthy();
  });
  it('labels an unverified agent', () => {
    render(<VerifiedAvatarRing state="unverified"><img alt="a" /></VerifiedAvatarRing>);
    expect(screen.getByText('Not verified')).toBeTruthy();
  });
});
