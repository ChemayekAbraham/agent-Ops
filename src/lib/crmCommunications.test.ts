import { describe, expect, it } from 'vitest';
import { communicationDashboardRole, kampalaInput, kampalaInputToIso, validateCommunication, type CommunicationContent } from './crmCommunications';
const valid = (): CommunicationContent => ({ id: 'test', revision_id: 'revision', title: 'Notice', body: 'Recorded information', communication_type: 'important', audiences: ['agent'], link_path: '', starts_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), confirm_everyone: false });
describe('communications audience and dates', () => {
 it.each(['/dashboard/agent', '/dashboard/agent-new', '/dashboard/agent-bk', '/dashboard/agent/proxy'])('uses the agent dashboard role for %s', p => expect(communicationDashboardRole(p, 'tenant')).toBe('agent'));
 it.each(['/dashboard/funder', '/dashboard/funder-new', '/dashboard/funders/bk', '/dashboard/funder/portfolio'])('uses supporter role for %s', p => expect(communicationDashboardRole(p, 'agent')).toBe('supporter'));
 it('does not display dashboard communications on public pages', () => expect(communicationDashboardRole('/auth', 'agent')).toBeNull());
 it('uses staff dashboard roles rather than another active persona', () => expect(communicationDashboardRole('/crm/dashboard', 'tenant')).toBe('crm'));
 it('uses the current operational role in operational dashboards', () => expect(communicationDashboardRole('/landlord-ops', 'operations')).toBe('operations'));
 it('converts Kampala time independently of device timezone', () => { expect(kampalaInput('2026-10-16T08:41:00.000Z')).toBe('2026-10-16T11:41'); expect(kampalaInputToIso('2026-10-16T11:41')).toBe('2026-10-16T08:41:00.000Z'); });
 it('rejects invalid Kampala times', () => expect(() => kampalaInputToIso('')).toThrow());
 it('accepts a valid communication', () => expect(validateCommunication(valid())).toBeNull());
 it('requires an audience', () => expect(validateCommunication({ ...valid(), audiences: [] })).toMatch(/audience/));
 it('keeps Everyone separate', () => expect(validateCommunication({ ...valid(), audiences: ['everyone', 'agent'] })).toMatch(/Everyone/));
 it('rejects arbitrary destinations', () => expect(validateCommunication({ ...valid(), link_path: 'https://external.example' })).toMatch(/approved/));
 it('rejects expired and reverse windows', () => { expect(validateCommunication({ ...valid(), expires_at: '2020-01-01T00:00:00Z' })).toMatch(/Expiry/); expect(validateCommunication({ ...valid(), starts_at: '2099-01-02T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' })).toMatch(/Expiry/); });
 it('requires a title and bounds plain message length', () => { expect(validateCommunication({ ...valid(), title: '' })).toMatch(/title/); expect(validateCommunication({ ...valid(), body: 'x'.repeat(8001) })).toMatch(/message/); });
});
