import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Avatar, AvatarFallback, AvatarImage } from './avatar';

vi.mock('@/hooks/useSignedUrl', () => ({ useSignedUrl: (src: string) => src }));
afterEach(() => vi.unstubAllGlobals());

it('falls back to initials and does not reload the same failed avatar on rerender', async () => {
  const requests: string[] = [];
  let fail: (() => void) | undefined;
  vi.stubGlobal('Image', class extends EventTarget {
    private currentSrc = '';
    get src() { return this.currentSrc; }
    set src(value: string) {
      if (value === this.currentSrc) return;
      this.currentSrc = value;
      requests.push(value);
      fail = () => { this.dispatchEvent(new Event('error')); };
    }
  });
  const content = <Avatar><AvatarImage src="https://example.test/missing.jpg" /><AvatarFallback>JW</AvatarFallback></Avatar>;
  const { rerender } = render(content);
  await waitFor(() => expect(requests).toHaveLength(1));
  act(() => fail?.());
  expect(screen.getByText('JW')).toBeVisible();
  rerender(<Avatar><AvatarImage src="https://example.test/missing.jpg" /><AvatarFallback>JW</AvatarFallback></Avatar>);
  expect(requests).toEqual(['https://example.test/missing.jpg']);
});