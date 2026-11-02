import { describe, expect, it } from 'vitest';
import { standingOrderErrorText } from '@/lib/standingOrderError';

describe('standing-order stored error extraction', () => {
  it('extracts the message field without exposing the serialized envelope', () => {
    const envelope = { code: 'TEST_FAILURE', message: 'diagnostic fixture' };
    expect(standingOrderErrorText(JSON.stringify(envelope))).toBe(envelope.message);
  });
  it.each([null, '', 'plain diagnostic', '{"message":', '{"message":42}', 'null'])('preserves non-message diagnostics: %s', (input) => {
    expect(standingOrderErrorText(input)).toBe(input);
  });
  it('handles a truncated degraded-service response like the full response without altering input', () => {
    const raw = '{"code":"SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED","message":"Service is temporarily unavailable"}';
    expect(standingOrderErrorText(raw.slice(0, 55))).toBe(standingOrderErrorText(raw));
    expect(JSON.parse(raw).code).toBe('SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED');
  });
});