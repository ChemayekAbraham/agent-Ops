import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AwarenessCallBadge } from './AwarenessCallBadge';

const status = (over: Record<string, unknown> = {}) => ({
  rent_request_id: 'rr-1', calls_total: 0, calls_at_current_stage: 0, answered_at_current_stage: 0, last_call_at: null, answered_person_types: [], ...over,
}) as never;

describe('AwarenessCallBadge', () => {
  it('shows "No call yet at this stage"', () => {
    render(<AwarenessCallBadge status={status()} />);
    const b = screen.getByTestId('awareness-call-badge');
    expect(b).toHaveTextContent('No call yet at this stage');
    expect(b).toHaveAttribute('data-state', 'no-call');
  });

  it('shows "Called N times"', () => {
    render(<AwarenessCallBadge status={status({ calls_total: 3, calls_at_current_stage: 3, answered_at_current_stage: 1, answered_person_types: ['tenant'] })} />);
    const b = screen.getByTestId('awareness-call-badge');
    expect(b).toHaveTextContent('Called 3 times');
    expect(b).toHaveAttribute('data-state', 'called');
    expect(b).toHaveAttribute('title', expect.stringContaining('1 answered'));
  });

  it('shows nothing while the status is unknown, and is not a button', () => {
    const { container } = render(<AwarenessCallBadge status={undefined} />);
    expect(container).toBeEmptyDOMElement();
    render(<AwarenessCallBadge status={status()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
