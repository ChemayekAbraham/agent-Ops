import { useEffect, type ReactNode } from 'react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { AUTOCALL_CATEGORIES, AUTOCALL_CATEGORY_LABELS, type AutocallCategory } from '@/lib/voiceAutocall';
import { formatUGX } from '@/lib/rentCalculations';
export const categoryLabel = (c: AutocallCategory) => AUTOCALL_CATEGORY_LABELS[c];
export const timeLabel = (v?: string | null) => v ? new Date(v).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const relative = (v?: string | null) => v ? formatDistanceToNow(new Date(v), { addSuffix: true }) : 'not yet';
export const duration = (s: number) => `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
export const money = (n?: number | null, currency?: string | null) => n == null ? 'Unavailable' : !currency || currency === 'UGX' ? formatUGX(n) : `${currency} ${n.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
export function useReadError(error: unknown) { useEffect(() => { if (error) toast.error(error instanceof Error ? error.message : String(error)); }, [error]); }
export async function perform(action: () => Promise<unknown>, success: string, after?: () => void) { try { await action(); toast.success(success); after?.(); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } }
export function QueryState({ pending, error, retry, empty, children }: { pending: boolean; error: unknown; retry: () => unknown; empty?: boolean; children: ReactNode }) {
 useReadError(error);
 if (pending) return <div className="space-y-3"><Skeleton className="h-12 w-full"/><Skeleton className="h-60 w-full"/></div>;
 if (error) return <div role="alert" className="space-y-3 py-6 text-destructive"><p>{error instanceof Error ? error.message : String(error)}</p><Button variant="outline" onClick={retry}>Try again</Button></div>;
 if (empty) return <p className="py-12 text-center text-muted-foreground">No records found.</p>;
 return <>{children}</>;
}
export function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
 return <div className="min-w-0 space-y-2"><Label>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="w-full"><SelectValue/></SelectTrigger><SelectContent>{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select></div>;
}
export function CategoryPicker({ value, onChange, all = false }: { value: AutocallCategory | 'all'; onChange: (v: AutocallCategory | 'all') => void; all?: boolean }) {
 return <Choice label="Category" value={value} onChange={v => onChange(v as AutocallCategory | 'all')} options={[...(all ? [{ value: 'all', label: 'All categories' }] : []), ...AUTOCALL_CATEGORIES.map(value => ({ value, label: categoryLabel(value) }))]}/>;
}
