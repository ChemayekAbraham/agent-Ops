import { describe, expect, it } from 'vitest';
import { CHAIN_BATCH_LIMIT, agentChainLines, chainIdsKey, normalizeAgentChain, whatsAppNumber } from './rentAgentChain';

const base = {
  request_id: 'r1',
  registering_agent_id: 'a1', registering_agent_name: 'Sub Agent', registering_agent_phone: '0701111111',
  parent_agent_id: 'p1', parent_agent_name: 'Main Agent', parent_agent_phone: '0702222222',
  assigned_agent_id: 'a1', assigned_agent_name: 'Sub Agent', assigned_agent_phone: '0701111111',
  is_verified_subagent: true, assigned_differs: false,
};
const lines = (r: object) => agentChainLines(normalizeAgentChain([r])[0]);

describe('parent resolution', () => {
  it('shows Sub-agent and Main agent for a verified link, each with its own phone', () => {
    const l = lines(base);
    expect(l.map((x) => x.role)).toEqual(['Sub-agent', 'Main agent']);
    expect(l[0].person).toMatchObject({ name: 'Sub Agent', phone: '0701111111' });
    expect(l[1].person).toMatchObject({ name: 'Main Agent', phone: '0702222222' });
  });
  it.each(['pending_acceptance', 'expired', 'rejected'])('shows one Agent line when the link is %s (server returns no verified flag)', () => {
    const l = lines({ ...base, is_verified_subagent: false, parent_agent_id: null, parent_agent_name: null, parent_agent_phone: null });
    expect(l.map((x) => x.role)).toEqual(['Agent']);
  });
  it('never shows a parent unless the verified flag is true', () => {
    expect(lines({ ...base, is_verified_subagent: false }).map((x) => x.role)).toEqual(['Agent']);
  });
  it('adds Assigned agent as a third line when a different person, with their own phone', () => {
    const l = lines({ ...base, assigned_differs: true, assigned_agent_id: 'a2', assigned_agent_name: 'Other', assigned_agent_phone: '0703333333' });
    expect(l.map((x) => x.role)).toEqual(['Sub-agent', 'Main agent', 'Assigned agent']);
    expect(l[2].person).toMatchObject({ name: 'Other', phone: '0703333333' });
  });
  it('falls back to the caller agent line with no answer', () => {
    expect(agentChainLines(null, { id: 'x', name: 'Fallback', phone: '0700' }).map((x) => x.role)).toEqual(['Agent']);
    expect(agentChainLines(null)).toEqual([]);
  });
});

describe('helpers', () => {
  it('builds WhatsApp numbers for Uganda', () => {
    expect(whatsAppNumber('0701234567')).toBe('256701234567');
    expect(whatsAppNumber('+256 701 234 567')).toBe('256701234567');
    expect(whatsAppNumber(null)).toBe('');
  });
  it('keys ids regardless of order and duplicates', () => {
    expect(chainIdsKey(['b', 'a', 'a'])).toBe(chainIdsKey(['a', 'b']));
    expect(CHAIN_BATCH_LIMIT).toBe(200);
  });
});
