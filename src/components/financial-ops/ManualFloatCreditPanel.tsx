import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Wallet, ShieldCheck, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';
import { formatUGX } from '@/lib/rentCalculations';
import { normaliseFloatTid, parseFloatCreditMessage } from '@/lib/floatCreditMessage';

interface PickedUser { id: string; full_name: string; phone: string }

function toIsoLocal(dt: string): string | null {
  // dt from <input type="datetime-local"> is "YYYY-MM-DDTHH:mm"
  if (!dt) return null;
  const d = new Date(dt);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function ManualFloatCreditPanel() {
  const qc = useQueryClient();
  const [user, setUser] = useState<PickedUser | null>(null);
  const [tid, setTid] = useState('');
  const [amount, setAmount] = useState('');
  const [depositedAt, setDepositedAt] = useState<string>(() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  });
  // Captured in parts; `p_depositor_name` stays one concatenated string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const depositorName = joinPersonName(nameParts);
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pasted, setPasted] = useState('');
  const [pasteWarnings, setPasteWarnings] = useState<string[]>([]);

  const amountNum = Number((amount || '').replace(/,/g, ''));
  // Same form the TID lock stores ("TID157…" / "157…." would dodge it).
  const cleanTid = normaliseFloatTid(tid);

  const readPastedMessage = () => {
    const r = parseFloatCreditMessage(pasted);
    const warnings: string[] = [];
    if (r.tid) setTid(r.tid); else warnings.push('No TID found — type it in.');
    if (r.amount) setAmount(String(r.amount)); else warnings.push('No amount found — type it in.');
    if (r.depositedAtLocal) setDepositedAt(r.depositedAtLocal);
    if (r.timeMissing) {
      warnings.push(
        r.depositedAtLocal
          ? 'The message has a date but no time — set the time from the SMS.'
          : 'The message has no date/time (Airtel never includes it) — set it from the SMS.',
      );
    }
    if (r.nameParts) setNameParts(r.nameParts);
    else warnings.push(
      r.senderPhone
        ? `Sender shown only as ${r.senderPhone} — type the depositor's name.`
        : "No sender name found — type the depositor's name.",
    );
    if (r.direction === 'out') {
      warnings.push('This looks like a money SENT message, not money received. Check before crediting.');
    }
    setPasteWarnings(warnings);
    if (r.tid || r.amount) toast.success('Message read — check the fields below.');
    else toast.error('Could not read a TID or amount from that message.');
  };

  const canSubmit =
    !!user &&
    cleanTid.length >= 4 &&
    Number.isFinite(amountNum) &&
    amountNum > 0 &&
    !!depositedAt &&
    validatePersonNameParts(nameParts).valid;

  const credit = useMutation({
    mutationFn: async () => {
      const iso = toIsoLocal(depositedAt);
      if (!iso) throw new Error('Invalid date/time');
      const { data, error } = await (supabase.rpc as any)('finops_manual_float_credit', {
        p_user_id: user!.id,
        p_tid: cleanTid,
        p_amount: amountNum,
        p_deposited_at: iso,
        p_depositor_name: depositorName.trim(),
        p_notes: notes.trim() || null,
      });
      if (error) throw error;
      const result = data as { ok: boolean; transaction_group_id: string };
      // Fire-and-forget SMS notify to the agent
      supabase.functions
        .invoke('notify-manual-float-credit', {
          body: {
            user_id: user!.id,
            amount: amountNum,
            tid: cleanTid,
            transaction_group_id: result.transaction_group_id,
          },
        })
        .catch((e) => console.warn('notify-manual-float-credit failed', e));
      return result;
    },
    onSuccess: (res) => {
      toast.success(`Float credited — TID ${cleanTid} locked. Ref ${res.transaction_group_id.slice(0, 8)}`);
      setTid('');
      setAmount('');
      setNameParts({ firstName: '', otherNames: '', lastName: '' });
      setNotes('');
      setPasted('');
      setPasteWarnings([]);
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ['bridge-health'] });
      qc.invalidateQueries({ queryKey: ['bridge-recent'] });
    },
    onError: (e: Error) => {
      setConfirming(false);
      toast.error(e.message);
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-5 w-5" /> Manual Float Credit (TID-locked)
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Fill the TID, amount, deposit date/time and depositor's name. We post a balanced
            double-entry (float credit + platform offset) and lock the TID so a late IFTTT/email
            arrival cannot double-credit.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <UserSearchPicker
              label="Recipient user (agent / partner)"
              placeholder="Search by name, phone or email…"
              selectedUser={user}
              onSelect={setUser}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mfc-paste">Paste the MTN / Airtel message (optional)</Label>
            <Textarea
              id="mfc-paste"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="e.g. RECEIVED. TID157623817657 UGX 4,000,000 from 759209694 …"
              rows={3}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!pasted.trim()}
              onClick={readPastedMessage}
            >
              Fill from message
            </Button>
            {pasteWarnings.length > 0 && (
              <ul className="text-xs text-amber-700 space-y-0.5">
                {pasteWarnings.map((w) => (
                  <li key={w} className="flex items-start gap-1">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {w}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="mfc-tid">Transaction ID (TID)</Label>
              <Input
                id="mfc-tid"
                value={tid}
                onChange={(e) => setTid(e.target.value)}
                placeholder="e.g. 152535220332"
                inputMode="numeric"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mfc-amount">Amount (UGX)</Label>
              <Input
                id="mfc-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="50000"
                inputMode="decimal"
              />
              {amountNum > 0 && (
                <div className="text-xs text-muted-foreground">{formatUGX(amountNum)}</div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mfc-dt">Deposit date &amp; time</Label>
              <Input
                id="mfc-dt"
                type="datetime-local"
                value={depositedAt}
                onChange={(e) => setDepositedAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Depositor's name (as on SMS)</Label>
              <PersonNameFields idPrefix="mfc-depositor" value={nameParts} onChange={setNameParts} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mfc-notes">Notes (optional)</Label>
            <Textarea
              id="mfc-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Why this manual credit is being posted (e.g. IFTTT feed silent, verified from phone photo)"
              rows={2}
            />
          </div>

          {!confirming ? (
            <Button
              className="w-full sm:w-auto"
              disabled={!canSubmit || credit.isPending}
              onClick={() => setConfirming(true)}
            >
              Review &amp; credit float
            </Button>
          ) : (
            <div className="rounded-md border p-3 space-y-3 bg-muted/30">
              <div className="flex items-start gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 mt-0.5 text-emerald-600" />
                <div className="space-y-1">
                  <div><span className="text-muted-foreground">User:</span> <span className="font-medium">{user?.full_name}</span> <span className="text-muted-foreground">({user?.phone})</span></div>
                  <div><span className="text-muted-foreground">Amount:</span> <span className="font-semibold">{formatUGX(amountNum)}</span></div>
                  <div><span className="text-muted-foreground">TID:</span> <span className="font-mono">{cleanTid}</span></div>
                  <div><span className="text-muted-foreground">When:</span> {new Date(depositedAt).toLocaleString()}</div>
                  <div><span className="text-muted-foreground">Depositor:</span> {depositorName.trim()}</div>
                </div>
              </div>
              <div className="flex items-start gap-2 text-xs text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5" />
                This posts a real double-entry credit. TID will be locked and cannot be reversed
                from this screen — use the ledger tools to reverse if needed.
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => credit.mutate()}
                  disabled={credit.isPending}
                >
                  {credit.isPending ? 'Posting…' : 'Confirm credit'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={credit.isPending}>
                  Back
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
export default ManualFloatCreditPanel;
