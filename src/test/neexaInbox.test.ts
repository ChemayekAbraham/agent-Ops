import { describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
import { canSendNeexaReply, whatsappWindowClosed, normalizeNeexaPhone, neexaPlaceholderNumbers,
  fillNeexaTemplate, neexaErrorMessage, mergeNeexaRows, sortNeexaConversations } from '@/hooks/useNeexaInbox';
const now = Date.parse('2026-10-21T07:45:00Z');
const open = { platform: 'whatsapp' as const, last_inbound_at: '2026-10-21T07:00:00Z' };
describe('Neexa Inbox rules', () => {
  it('accepts 4096 characters and refuses 4097', () => {
    expect(canSendNeexaReply('a'.repeat(4096), open, now)).toBe(true);
    expect(canSendNeexaReply('a'.repeat(4097), open, now)).toBe(false);
    expect(canSendNeexaReply('   ', open, now)).toBe(false);
  });
  it('closes WhatsApp replies at 24 hours and when there is no inbound message', () => {
    expect(whatsappWindowClosed({ ...open, last_inbound_at: '2026-10-20T07:45:01Z' }, now)).toBe(false);
    expect(canSendNeexaReply('Reply', { ...open, last_inbound_at: '2026-10-20T07:45:00Z' }, now)).toBe(false);
    expect(whatsappWindowClosed({ ...open, last_inbound_at: null }, now)).toBe(true);
    expect(whatsappWindowClosed({ platform: 'email', last_inbound_at: null }, now)).toBe(false);
  });
  it('accepts Ugandan local numbers and requires + for other countries', () => {
    expect(normalizeNeexaPhone('0772 123 456')).toBe('+256772123456');
    expect(normalizeNeexaPhone('+254 712 345678')).toBe('+254712345678');
    expect(normalizeNeexaPhone('254712345678')).toBeNull();
  });
  it('fills indexed template variables independently and without duplicate inputs', () => {
    expect(neexaPlaceholderNumbers('{{2}} {{1}} {{2}}')).toEqual([1, 2]);
    expect(fillNeexaTemplate('Hello {{1}}, your Rent Plan is {{2}}', { 1: 'Sarah', 2: 'ready' })).toBe('Hello Sarah, your Rent Plan is ready');
  });
  it('maps banned terms, upstream errors and forbidden access', () => {
    expect(neexaErrorMessage({ error: 'banned_term', term: 'loan' }, 422)).toContain("'loan' isn't allowed");
    expect(neexaErrorMessage({ error: 'neexa_error', message: 'Invalid recipient' }, 422)).toBe('Invalid recipient');
    expect(neexaErrorMessage({ error: 'neexa_error', message: 'Raw upstream text' }, 502)).toBe("Neexa couldn't deliver this right now.");
    expect(neexaErrorMessage({}, 403)).toBe("You don't have access to the inbox.");
  });
  it('merges inserts and updates without duplicate messages', () => {
    expect(mergeNeexaRows([{ id: '1', status: 'pending' }], [{ id: '1', status: 'read' }, { id: '2', status: 'delivered' }])).toEqual([{ id: '1', status: 'read' }, { id: '2', status: 'delivered' }]);
  });
  it('sorts conversations newest first with null dates last', () => {
    const rows = [{ id: 'empty', last_message_at: null }, { id: 'old', last_message_at: '2026-10-19T00:00:00Z' }, { id: 'new', last_message_at: '2026-10-21T00:00:00Z' }];
    expect(sortNeexaConversations(rows as Parameters<typeof sortNeexaConversations>[0]).map(row => row.id)).toEqual(['new', 'old', 'empty']);
  });
});
