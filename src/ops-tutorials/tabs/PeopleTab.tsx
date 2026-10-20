import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { eligiblePeople, listRates, listTopics, membersList, setMemberById } from '../api';
import RateStrip, { RATE_TIERS } from '../components/RateStrip';

const contact = (p: any) => p?.phone || p?.email || '—';
const rolesText = (p: any) => {
  const r = p?.tutorial_roles;
  return Array.isArray(r) ? r.join(', ') : r ? String(r) : '';
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function PeopleTab({ canSetRates, onChangeRates }: { canSetRates: boolean; onChangeRates: () => void }) {
  const [members, setMembers] = useState<any[]>([]);
  const [topics, setTopics] = useState<any[]>([]);
  const [rates, setRates] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<any[]>([]);
  const [personId, setPersonId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [role, setRole] = useState('creator');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, t, r, pp] = await Promise.all([membersList(), listTopics(), listRates(), eligiblePeople()]);
      setMembers(m ?? []); setPeople(pp ?? []); setTopics(t ?? []); setRates(r ?? []);
      setRefreshKey((k) => k + 1);
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); toast.success(ok); await load(); return true; }
    catch (e) { toast.error(errText(e)); return false; }
    finally { setBusy(null); }
  }

  const selected = people.find((pp) => pp.user_id === personId) ?? null;

  const rateSet = new Set(rates.filter((r) => Number(r.amount_ugx) > 0).map((r) => r.tier));
  const checklist = [
    { ok: members.some((m) => m.enabled && m.member_role === 'creator'), label: 'At least one active Creator', hint: 'HR adds them above' },
    { ok: members.some((m) => m.enabled && m.member_role === 'reviewer'), label: 'At least one active Reviewer', hint: 'HR adds them above' },
    { ok: topics.some((t) => t.status === 'open'), label: 'At least one open topic', hint: 'A reviewer opens topics in Review → Topics' },
    { ok: RATE_TIERS.every((t) => rateSet.has(t.tier)), label: 'All four rates set', hint: 'HR, COO, CEO or CFO sets them in Rates' },
  ];

  return (
    <div className="space-y-8">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <section className="space-y-3">
        <h2 className="text-base font-semibold">People</h2>
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem_1fr_auto] sm:items-end">
          <div className="space-y-1"><Label>Person</Label>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" aria-expanded={pickerOpen} className="w-full justify-between font-normal">
                  <span className="truncate">{selected ? selected.full_name ?? contact(selected) : 'Choose an employee'}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[16rem] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search by name, phone or email" />
                  <CommandList>
                    <CommandEmpty>No matching employee.</CommandEmpty>
                    <CommandGroup>
                      {people.map((pp) => (
                        <CommandItem key={pp.user_id} value={`${pp.full_name ?? ''} ${pp.phone ?? ''} ${pp.email ?? ''} ${pp.user_id}`}
                          onSelect={() => { setPersonId(pp.user_id); setPickerOpen(false); }}>
                          <Check className={`mr-2 h-4 w-4 ${personId === pp.user_id ? 'opacity-100' : 'opacity-0'}`} />
                          <div className="min-w-0">
                            <div className="truncate">{pp.full_name ?? '—'} <span className="text-muted-foreground">· {contact(pp)}</span></div>
                            {rolesText(pp) && <div className="truncate text-xs text-muted-foreground">{rolesText(pp)}</div>}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover></div>
          <div className="space-y-1"><Label>Role</Label>
            <Select value={role} onValueChange={setRole}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="creator">Creator</SelectItem><SelectItem value="reviewer">Reviewer</SelectItem><SelectItem value="viewer">Viewer</SelectItem></SelectContent>
            </Select></div>
          <div className="space-y-1"><Label>Note</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <Button disabled={!personId || busy === 'add'}
            onClick={async () => { if (personId && await run('add', () => setMemberById({ p_user_id: personId, p_role: role, p_enabled: true, p_note: note.trim() || null }), 'Member saved')) { setPersonId(null); setNote(''); } }}>
            Add
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Viewer: can open the library (add COO/CFO as Viewer so they can reach Rates)</p>
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Phone/Email</TableHead><TableHead>Role</TableHead><TableHead>Enabled</TableHead><TableHead>Note</TableHead></TableRow></TableHeader>
            <TableBody>
              {!members.length && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No members yet.</TableCell></TableRow>}
              {members.map((m) => {
                const key = `${m.user_id}:${m.member_role}`;
                return (
                  <TableRow key={key}>
                    <TableCell>{m.full_name ?? '—'}</TableCell>
                    <TableCell className="break-all">{contact(m)}</TableCell>
                    <TableCell className="capitalize">{m.member_role}</TableCell>
                    <TableCell>
                      <Switch checked={!!m.enabled} disabled={busy === key}
                        onCheckedChange={() => run(key, () => setMemberById({ p_user_id: m.user_id, p_role: m.member_role, p_enabled: !m.enabled, p_note: m.note ?? null }), m.enabled ? 'Member disabled' : 'Member enabled')} />
                    </TableCell>
                    <TableCell>{m.note ?? ''}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Rates</h2>
          {canSetRates && <Button variant="link" size="sm" className="h-auto p-0" onClick={onChangeRates}>Change rates</Button>}
        </div>
        <RateStrip refreshKey={refreshKey} />
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Setup checklist</h2>
        <ul className="space-y-2">
          {checklist.map((c) => (
            <li key={c.label} className="flex items-start gap-2 text-sm">
              {c.ok ? <Check className="mt-0.5 h-4 w-4 text-primary" aria-label="Done" /> : <X className="mt-0.5 h-4 w-4 text-destructive" aria-label="Not done" />}
              <span><span className="font-medium">{c.label}</span> <span className="text-muted-foreground">— {c.hint}</span></span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
