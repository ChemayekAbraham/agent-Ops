import { describe, it, expect, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { safeUUID } from '@/lib/safeUUID';
import { isAbortLike, isAudioStartError } from '@/lib/errorReporting';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('client crash fixes', () => {
  it('safeUUID returns a lowercase v4 uuid when crypto.randomUUID is missing', () => {
    const orig = globalThis.crypto.randomUUID;
    (globalThis.crypto as any).randomUUID = undefined;
    try {
      expect(safeUUID()).toMatch(UUID_V4);
    } finally {
      (globalThis.crypto as any).randomUUID = orig;
    }
  });

  it('treats aborted requests as non-crashes', () => {
    expect(isAbortLike('signal is aborted without reason')).toBe(true);
    expect(isAbortLike({ name: 'AbortError', message: 'x' })).toBe(true);
    expect(isAbortLike('t.preview is undefined')).toBe(false);
  });

  it('recognises audio-start failures', () => {
    expect(isAudioStartError('Failed to start the audio device')).toBe(true);
    expect(isAudioStartError('Something else broke')).toBe(false);
  });
});
