import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Avatar, AvatarFallback, AvatarImage } from './avatar';

const signing = vi.hoisted(() => ({ pending: false }));
vi.mock('@/hooks/useSignedUrl', () => ({ useSignedUrl: (src: string) => signing.pending ? undefined : src }));
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

it('loads the profile picture when signing finishes instead of caching the loading placeholder as a failure', async () => {
  const requests: string[] = [];
  let load: (() => void) | undefined;
  vi.stubGlobal('Image', class extends EventTarget {
    set src(value: string) {
      requests.push(value);
      load = () => this.dispatchEvent(new Event('load'));
    }
  });
  const url = 'https://example.test/profile-signed.jpg';
  const content = <Avatar><AvatarImage src={url} alt="Inviter profile" /><AvatarFallback>JW</AvatarFallback></Avatar>;
  signing.pending = true;
  const { rerender } = render(content);
  expect(requests).toHaveLength(0);
  signing.pending = false;
  rerender(content);
  // Force a parent render after the signing hook supplies the usable URL.
  rerender(<Avatar><AvatarImage src={url} alt="Inviter profile" /><AvatarFallback>JW</AvatarFallback></Avatar>);
  await waitFor(() => expect(requests).toEqual([url]));
  act(() => load?.());
  expect(screen.getByRole('img', { name: 'Inviter profile' })).toHaveAttribute('src', url);
});