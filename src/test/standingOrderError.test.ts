import { describe, expect, it } from 'vitest';
import { showStandingOrderWarning, standingOrderErrorText } from '@/lib/standingOrderError';

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

describe('paused historical outage warnings', () => {
  const order = { enabled: false, target_missing: false, health: 'failing', last_run_error: '{"code":"SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED","message":"Service is temporarily unavailable"}' };
  it('suppresses the old outage on a paused order without changing recorded state', () => {
    const before = { ...order };
    expect(showStandingOrderWarning(order)).toBe(false);
    expect(order).toEqual(before);
  });
  it('keeps an active order failure visible', () => {
    expect(showStandingOrderWarning({ ...order, enabled: true })).toBe(true);
  });
  it('keeps missing-recipient warnings visible', () => {
    expect(showStandingOrderWarning({ ...order, target_missing: true })).toBe(true);
  });
  it('keeps stalled-order warnings visible', () => {
    expect(showStandingOrderWarning({ ...order, health: 'stalled' })).toBe(true);
  });
  it('does not suppress other failures on paused orders', () => {
    expect(showStandingOrderWarning({ ...order, last_run_error: 'Recipient routing failed' })).toBe(true);
  });
});