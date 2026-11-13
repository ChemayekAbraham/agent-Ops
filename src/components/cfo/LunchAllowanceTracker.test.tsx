import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LunchAllowanceTracker } from './LunchAllowanceTracker';

vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({
  data: { list: [], names: {} }, isLoading: false, isFetching: false, refetch: vi.fn(),
}) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
afterEach(cleanup);

it('opens the calendar directly from Custom and reopens it on another tap', () => {
  render(<LunchAllowanceTracker />);
  const custom = screen.getByRole('tab', { name: 'Custom' });
  fireEvent.mouseDown(custom, { button: 0, ctrlKey: false });
  fireEvent.click(custom);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(custom);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});