import { useState } from 'react';
import { PhoneCall } from 'lucide-react';
import { useAutocallDemoCall, useAutocallDemoConfig, useAutocallScripts } from '@/hooks/useVoiceAutocall';
import type { AutocallCategory } from '@/lib/voiceAutocall';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Choice, perform } from './shared';

const categories = [
  { value: 'tenant', label: 'Tenant' },
  { value: 'employee', label: 'Employee' },
  { value: 'partner', label: 'Supporter' },
] as const;

export function AutocallDemoCalls() {
  const scripts = useAutocallScripts(null, false);
  const config = useAutocallDemoConfig();
  const call = useAutocallDemoCall();
  const [choices, setChoices] = useState<Partial<Record<AutocallCategory, string>>>({});
  const [target, setTarget] = useState<{ id: string; name: string; label: string } | null>(null);
  const ready = Boolean(config.data?.phone) && !config.error;

  return <section aria-label="Test calls" className="space-y-4 border-b pb-5">
    <div><h3 className="font-semibold">Test calls · {config.data?.phone ?? '0701355245'}</h3>
      {!config.isPending && !ready && <p role="status" className="mt-1 text-sm text-muted-foreground">Test calling to this number is not enabled yet.</p>}
      {scripts.error && <p role="alert" className="mt-1 text-sm text-destructive">Could not load scripts.</p>}
    </div>
    <div className="grid gap-4 sm:grid-cols-3">{categories.map(category => {
      const options = (scripts.data ?? []).filter(s => s.category === category.value && s.is_active);
      const selected = options.find(s => s.id === choices[category.value]) ?? options[0];
      return <div key={category.value} className="min-w-0 space-y-3">
        {options.length > 0 ? <Choice label={`${category.label} script`} value={selected?.id ?? ''} onChange={id => setChoices(prev => ({ ...prev, [category.value]: id }))} options={options.map(s => ({ value: s.id, label: `${s.name} (v${s.version})` }))}/> : <p className="text-sm text-muted-foreground">{category.label} · {scripts.isPending ? 'Loading scripts…' : 'No active script'}</p>}
        <Button variant="outline" className="min-h-11 w-full" disabled={!ready || !selected || call.isPending} onClick={() => selected && setTarget({id: selected.id, name: selected.name, label: category.label})}><PhoneCall/>Call as {category.label}</Button>
      </div>;
    })}</div>
    <Dialog open={Boolean(target)} onOpenChange={open => !open && !call.isPending && setTarget(null)}><DialogContent><DialogHeader><DialogTitle>Call as {target?.label}?</DialogTitle><DialogDescription>A real recorded test call will go to {config.data?.phone} using “{target?.name}”. Normal airtime charges apply. Pressing 9 stops future automated calls to this number.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={call.isPending} onClick={() => setTarget(null)}>Cancel</Button><Button disabled={!ready || call.isPending} onClick={() => target && perform(() => call.mutateAsync({scriptId: target.id}), 'Test call queued. Follow its progress in Call Log.', () => setTarget(null))}><PhoneCall/>{call.isPending ? 'Requesting call…' : 'Confirm test call'}</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}