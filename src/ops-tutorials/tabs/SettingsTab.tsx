import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { listRates, membersList, setMember, setRate } from '../api';

const TIERS = [
  { tier: 'basic', label: 'Basic' },
  { tier: 'standard', label: 'Standard' },
  { tier: 'advanced', label: 'Advanced' },
  { tier: 'revision', label: 'Revision' },
];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function SettingsTab() {
  const [members, setMembers] = useState<any[]>([]);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('creator');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, r] = await Promise.all([membersList(), listRates()]);
      setMembers(m ?? []);
      const map: Record<string, number> = {};
      r.forEach((x: any) => { map[x.tier] = Number(x.amount_ugx); });
      setRates(map);
      setDrafts(Object.fromEntries(TIERS.map((t) => [t.tier, map[t.tier] != null ? String(map[t.tier]) : ''])));
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); toast.success(ok); await load(); return true; }
    catch (e) { toast.error(errText(e)); return false; }
    finally { setBusy(null); }
  }

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

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Rate card</h2>
        <p className="text-sm text-muted-foreground">Set after the CEO approves the rate card. Accepting a video fixes its rate; later changes do not re-price it.</p>
        <div className="space-y-2">
          {TIERS.map(({ tier, label }) => {
            const draft = drafts[tier] ?? '';
            const n = Number(draft.replace(/,/g, ''));
            const valid = draft.trim() !== '' && Number.isFinite(n) && n >= 0;
            return (
              <div key={tier} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
                <div className="min-w-[8rem] flex-1">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">Current: {rates[tier] != null ? formatUGX(rates[tier]) : 'Not set'}</p>
                </div>
                <Input inputMode="numeric" className="w-40" placeholder="UGX" value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [tier]: e.target.value }))} />
                <Button size="sm" disabled={!valid || busy === tier || n === rates[tier]}
                  onClick={() => run(tier, () => setRate({ p_tier: tier, p_amount: n }), `${label} rate saved`)}>Save</Button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
