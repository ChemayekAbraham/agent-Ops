import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AllCallsWeeklySections } from './AllCallsWeeklySections';
import { pivotAllCalls } from '@/lib/callingCenterAllCalls';

const DAYS = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];
const LABELS = DAYS.map((d) => d.slice(5));
const pivot = pivotAllCalls(
  [
    { caller_id: 'a', caller_name: 'Amina', kampala_day: DAYS[0], subject_kind: 'tenant', source: 'calling_center', answered: true, calls: 5 },
    { caller_id: 'a', caller_name: 'Amina', kampala_day: DAYS[1], subject_kind: 'landlord', source: 'awareness', answered: false, calls: 2 },
  ],
  DAYS,
);

describe('AllCallsWeeklySections', () => {
  it('shows both sections, the daily total row, the subtotal and the summary line', () => {
    render(<AllCallsWeeklySections dayLabels={LABELS} pivot={pivot} isLoading={false} error={null} />);
    expect(screen.getByText('All calls made and taken this week')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Who was called' })).toBeTruthy();
    expect(screen.getByText('Daily total — all calls')).toBeTruthy();
    expect(screen.getByText('Subtotal')).toBeTruthy();
    for (const label of ['Tenants', 'Landlords', 'Agents', 'Others']) expect(screen.getAllByText(label).length).toBe(1);
    const summary = screen.getByTestId('all-calls-summary').textContent ?? '';
    expect(summary).toContain('Calling Center: 5');
    expect(summary).toContain('Answered: 5');
    expect(summary).toContain('Not answered: 2');
  });
  it('shows an error without hiding the page, and an empty week plainly', () => {
    render(<AllCallsWeeklySections dayLabels={LABELS} pivot={pivotAllCalls([], DAYS)} isLoading={false} error={new Error('boom')} />);
    expect(screen.getByText(/Could not load all calls: boom/)).toBeTruthy();
    expect(within(screen.getByTestId('all-calls-sections')).getAllByText('No call was recorded in this week.').length).toBeGreaterThan(0);
  });
});
