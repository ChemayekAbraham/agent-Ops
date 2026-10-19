import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listRates, listTopics, membersList, setMember } from '../api';
import RateStrip, { RATE_TIERS } from '../components/RateStrip';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function PeopleTab({ canSetRates, onChangeRates }: { canSetRates: boolean; onChangeRates: () => void }) {
  const [members, setMembers] = useState<any[]>([]);
  const [topics, setTopics] = useState<any[]>([]);
  const [rates, setRates] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('creator');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, t, r] = await Promise.all([membersList(), listTopics(), listRates()]);
      setMembers(m ?? []); setTopics(t ?? []); setRates(r ?? []);
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

  const rateSet = new Set(rates.filter((r) => r.amount_ugx != null).map((r) => r.tier));
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
          <div className="space-y-1"><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="space-y-1"><Label>Role</Label>
            <Select value={role} onValueChange={setRole}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="creator">Creator</SelectItem><SelectItem value="reviewer">Reviewer</SelectItem></SelectContent>
            </Select></div>
          <div className="space-y-1"><Label>Note</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <Button disabled={!email.trim() || busy === 'add'}
            onClick={async () => { if (await run('add', () => setMember({ p_email: email.trim(), p_role: role, p_enabled: true, p_note: note.trim() || null }), 'Member saved')) { setEmail(''); setNote(''); } }}>
            Add
          </Button>
        </div>
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Enabled</TableHead><TableHead>Note</TableHead></TableRow></TableHeader>
            <TableBody>
              {!members.length && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No members yet.</TableCell></TableRow>}
              {members.map((m) => {
                const key = `${m.user_id}:${m.member_role}`;
                return (
                  <TableRow key={key}>
                    <TableCell>{m.full_name ?? '—'}</TableCell>
                    <TableCell className="break-all">{m.email}</TableCell>
                    <TableCell className="capitalize">{m.member_role}</TableCell>
                    <TableCell>
                      <Switch checked={!!m.enabled} disabled={busy === key || !m.email}
                        onCheckedChange={() => run(key, () => setMember({ p_email: m.email, p_role: m.member_role, p_enabled: !m.enabled, p_note: m.note ?? null }), m.enabled ? 'Member disabled' : 'Member enabled')} />
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
