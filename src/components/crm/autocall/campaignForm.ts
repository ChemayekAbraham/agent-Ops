import type { AutocallCampaignInput } from '@/hooks/useVoiceAutocall';
export function campaignIssues(v: AutocallCampaignInput): string[] {
 const errors: string[] = [];
 const start = v.windowStart.slice(0,5); const end = v.windowEnd.slice(0,5);
 if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start < '08:00' || end > '19:00' || start >= end) errors.push('Choose a calling window between 08:00 and 19:00, with the end after the start.');
 if (!v.daysOfWeek.length || v.daysOfWeek.some(d => !Number.isInteger(d) || d < 1 || d > 6)) errors.push('Choose at least one day, Monday to Saturday.');
 if (!v.name.trim()) errors.push('Enter a campaign name.');
 if (!v.scriptId) errors.push('Choose a script.');
 if ((v.maxAttempts ?? 3) < 1 || (v.maxAttempts ?? 3) > 5 || !Number.isInteger(v.maxAttempts ?? 3)) errors.push('Tries must be a whole number from 1 to 5.');
 if ((v.retryMinutes ?? 120) < 15 || (v.retryMinutes ?? 120) > 1440 || !Number.isInteger(v.retryMinutes ?? 120)) errors.push('Minutes between tries must be from 15 to 1440.');
 if (v.scheduleKind === 'once') {
  const when = v.startAt ? new Date(v.startAt) : null;
  if (!when || !Number.isFinite(when.getTime())) errors.push('Choose a date and time.');
  else {
   const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(when);
   const weekday = parts.find(p => p.type === 'weekday')?.value;
   const time = `${parts.find(p => p.type === 'hour')?.value}:${parts.find(p => p.type === 'minute')?.value}`;
   if (weekday === 'Sun') errors.push('Choose a date from Monday to Saturday.');
   if (time < start || time >= end) errors.push('The one-time start must be inside the calling window.');
  }
 }
 return errors;
}
