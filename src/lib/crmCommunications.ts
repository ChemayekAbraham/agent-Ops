import type { AppRole } from '@/hooks/auth/types';
import { slugToRole } from '@/lib/roleRoutes';

export const communicationTypes = {
  announcement: { label: 'Announcement', button: 'Close' },
  information: { label: 'Information', button: 'Close' },
  important: { label: 'Important notice', button: 'Acknowledge' },
  action: { label: 'Action reminder', button: 'Close' },
} as const;
export type CommunicationType = keyof typeof communicationTypes;
export const communicationAudiences = [
  { value: 'agent', label: 'Agents' }, { value: 'supporter', label: 'Supporters' },
  { value: 'tenant', label: 'Tenants' }, { value: 'landlord', label: 'Landlords' },
  { value: 'everyone', label: 'Everyone' },
] as const;
export const communicationDestinations = [
  { value: '', label: 'No destination' }, { value: '/dashboard/agent', label: 'Agent dashboard' },
  { value: '/dashboard/tenant', label: 'Tenant dashboard' }, { value: '/dashboard/landlord', label: 'Landlord dashboard' },
  { value: '/dashboard/funder', label: 'Supporter dashboard' }, { value: '/settings', label: 'Settings' },
  { value: '/profile', label: 'Profile' }, { value: '/crm/dashboard', label: 'CRM dashboard' },
] as const;
export interface Communication {
  id: string; series_id: string; version: number; title: string; body: string;
  communication_type: CommunicationType; link_path: string | null; starts_at: string; expires_at: string;
  acknowledged_at?: string | null; audiences?: string[]; state?: string; status?: string;
  author_name?: string; created_at?: string; acknowledgements?: number;
  history?: { id: string; action: string; reason: string; created_at: string; actor_id: string }[];
}
export interface CommunicationContent {
  id: string; revision_id: string; title: string; body: string; communication_type: CommunicationType;
  audiences: string[]; link_path: string; starts_at: string; expires_at: string; confirm_everyone: boolean;
}
export function communicationDashboardRole(path: string, activeRole: AppRole | null): AppRole | null {
  if (/^\/dashboard\/agent(?:-new|-bk)?(?:\/|$)/.test(path)) return 'agent';
  if (/^\/dashboard\/(?:funder-new|funders\/bk)(?:\/|$)/.test(path)) return 'supporter';
  const persona = slugToRole(path);
  if (persona) return persona;
  if (/^\/(?:crm|cto|cfo|coo|ceo|cmo|hr)\/dashboard(?:\/|$)/.test(path)) {
    return path.split('/')[1] as AppRole;
  }
  if (/^\/(?:admin|agent-ops|tenant-ops|landlord-ops|partner-ops|operations|rd)(?:\/|$)/.test(path)) return activeRole;
  return null;
}
export function kampalaInput(value: string | Date): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() + 3 * 3600000).toISOString().slice(0, 16);
}
export function kampalaInputToIso(value: string): string {
  const date = new Date(`${value}:00+03:00`);
  if (!Number.isFinite(date.getTime())) throw new Error('Choose a valid Kampala date and time');
  return date.toISOString();
}
export const communicationTime = (value: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value));
export function validateCommunication(content: CommunicationContent): string | null {
  if (!content.title.trim() || content.title.trim().length > 160) return 'Enter a title of 1–160 characters.';
  if (!content.body.trim() || content.body.trim().length > 8000) return 'Enter a message of 1–8,000 characters.';
  if (!content.audiences.length) return 'Choose at least one audience.';
  if (content.audiences.includes('everyone') && content.audiences.length !== 1) return 'Everyone cannot be combined with another audience.';
  if (!communicationDestinations.some(d => d.value === content.link_path)) return 'Choose an approved destination.';
  if (new Date(content.expires_at).getTime() <= Math.max(Date.now(), new Date(content.starts_at).getTime())) return 'Expiry must be after the start and in the future.';
  return null;
}
