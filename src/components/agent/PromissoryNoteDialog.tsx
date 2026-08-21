import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileText, Check, Share2, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { PromissoryPlanMatcher } from '@/components/agent/PromissoryPlanMatcher';

interface PromissoryNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'self' = agent hand-picks tenants for the partner; 'auto' = the desk places them. */
  supportMode?: 'self' | 'auto';
}

export function PromissoryNoteDialog({ open, onOpenChange, supportMode = 'self' }: PromissoryNoteDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [createdNote, setCreatedNote] = useState<any>(null);
  // Flat validation fee for a promissory note, read from the database.
  // null = unavailable (never fall back to a hardcoded figure).
  const [noteRate, setNoteRate] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('partner_note_rate', {
          p_role: 'agent',
          p_at: new Date().toISOString(),
        });
        if (cancelled) return;
        const value = typeof data === 'number' ? data : Number(data);
        setNoteRate(!error && Number.isFinite(value) ? value : null);
      } catch {
        if (!cancelled) setNoteRate(null);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const earningsLine =
    noteRate === null
      ? 'Rate unavailable'
      : `You earn: ${formatUGX(noteRate)} when this note is validated`;

  // Captured in parts; `partner_name` stays one concatenated string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const partnerName = joinPersonName(nameParts);
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [amount, setAmount] = useState('');
  // True once the agent edits the amount by hand — after that, plan selections
  // never overwrite what they typed.
  const [amountTouched, setAmountTouched] = useState(false);
  const [contributionType, setContributionType] = useState<'monthly' | 'compounding'>('compounding');
  const [deductionDay, setDeductionDay] = useState('1');
  // Optional earmarking of ready-to-fund rent plans to this note.
  const [selectedPlanIds, setSelectedPlanIds] = useState<string[]>([]);
  const [attached, setAttached] = useState<{ count: number; amount: number }>({ count: 0, amount: 0 });

  const resetForm = () => {
    setNameParts({ firstName: '', otherNames: '', lastName: '' });
    setWhatsappNumber('');
    setPhoneNumber('');
    setEmail('');
    setAmount('');
    setAmountTouched(false);
    setContributionType('compounding');
    setDeductionDay('1');
    setCreatedNote(null);
    setSelectedPlanIds([]);
    setAttached({ count: 0, amount: 0 });
  };

  const handleClose = (v: boolean) => {
    if (!v) resetForm();
    onOpenChange(v);
  };

  const phoneDigits = (v: string) => v.replace(/\D/g, '');
  const isValidPhone = (v: string) => { const d = phoneDigits(v); return d.length === 10; };
  const isValid = validatePersonNameParts(nameParts).valid && isValidPhone(whatsappNumber) && Number(amount) > 0 && (!email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) && (!phoneNumber.trim() || isValidPhone(phoneNumber));

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const payload: Record<string, string | number | null> = {
        partner_name: partnerName.trim(),
        whatsapp_number: whatsappNumber.trim(),
        phone_number: phoneNumber.trim() || null,
        email: email.trim() || null,
        amount: Number(amount),
        // DB validation trigger only accepts 'monthly' | 'once_off'.
        // "Compounding" is the UI label for the once-off (lump-sum) note.
        contribution_type: contributionType === 'monthly' ? 'monthly' : 'once_off',
      };

      if (contributionType === 'monthly') {
        payload.deduction_day = String(Number(deductionDay));
        const now = new Date();
        const nextDate = new Date(now.getFullYear(), now.getMonth(), Number(deductionDay));
        if (nextDate <= now) nextDate.setMonth(nextDate.getMonth() + 1);
        payload.next_deduction_date = nextDate.toISOString().split('T')[0];
      }

      // One atomic server call: note + optional plan earmarks, validated server-side.
      const { data, error } = await supabase.rpc('agent_create_promissory_note', {
        p_payload: payload,
        p_rent_request_ids: selectedPlanIds,
      });
      if (error) throw error;

      const result = (data ?? {}) as { note?: Record<string, unknown>; attached_count?: number; attached_amount?: number };
      if (!result.note) throw new Error('Note was not created');
      setCreatedNote(result.note);
      // Fire-and-forget: partner gets the pledge SMS + email (tenants + 12-month
      // earnings). A 10-minute cron sweep retries anything that fails here.
      void supabase.functions
        .invoke('notify-promissory-note-pledge', { body: { note_id: (result.note as any).id } })
        .catch(() => {});
      setAttached({ count: Number(result.attached_count || 0), amount: Number(result.attached_amount || 0) });
      toast.success(
        Number(result.attached_count || 0) > 0
          ? `Note created with ${result.attached_count} tenant plan${Number(result.attached_count) === 1 ? '' : 's'} attached`
          : 'Promissory note created!',
      );
    } catch (err: any) {
      const raw = String(err?.message || 'Failed to create note');
      if (raw.includes('PLANS_UNAVAILABLE')) {
        setSelectedPlanIds([]);
        toast.error('Some selected plans are no longer available. Selection cleared — try again or create the note without plans.');
      } else if (raw.includes('PLANS_EXCEED_AMOUNT')) {
        toast.error('Attached plans total more than the promised amount.');
      } else {
        toast.error(raw);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleShareLink = async () => {
    if (!createdNote) return;
    let activationLink = `${getPublicOrigin()}/activate?token=${createdNote.activation_token}`;
    try {
      const { createShortLink } = await import('@/lib/createShortLink');
      const { data: { user: u } } = await (await import('@/integrations/supabase/client')).supabase.auth.getUser();
      if (u) {
        activationLink = await createShortLink(u.id, '/activate', { token: createdNote.activation_token });
      }
    } catch {}
    const shareText = `🤝 Hi ${partnerName}, activate your Welile funding account and start earning 15% ROI! ${activationLink}`;
    if (navigator.share) {
      navigator.share({ title: 'Welile Funding', text: shareText, url: activationLink }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(activationLink);
      toast.success('Activation link copied!');
    }
  };

  const parsedAmount = Number(amount) || 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent stable className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            {createdNote ? 'Note Created!' : 'Quick Promissory Note'}
          </DialogTitle>
        </DialogHeader>

        {createdNote ? (
          <div className="space-y-4">
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 text-center space-y-2">
              <div className="text-3xl">🎉</div>
              <p className="text-sm font-medium">Note for <span className="text-primary">{partnerName}</span> created!</p>
              <p className="text-lg font-bold text-primary">{formatUGX(parsedAmount)}</p>
              <p className="text-xs text-muted-foreground">
                {contributionType === 'monthly' ? `Monthly on day ${deductionDay}` : 'Once-off'} · <span className="text-primary font-semibold">{earningsLine}</span>
              </p>
              {attached.count > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {attached.count} tenant plan{attached.count === 1 ? '' : 's'} earmarked ·{' '}
                  <span className="font-semibold text-foreground">{formatUGX(attached.amount)}</span>
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Button variant="outline" onClick={handleShareLink} className="gap-2">
                <Share2 className="h-4 w-4" /> Share Activation Link
              </Button>
              <Button variant="ghost" onClick={() => handleClose(false)} className="text-xs">Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Partner Name *</Label>
              <div className="mt-0.5">
                <PersonNameFields idPrefix="promissory-partner" value={nameParts} onChange={setNameParts} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">WhatsApp * <span className="text-muted-foreground">(10 digits)</span></Label>
                <Input value={whatsappNumber} onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 10); setWhatsappNumber(v); }} placeholder="0780000000" type="tel" inputMode="numeric" className="mt-0.5 h-9" maxLength={10} minLength={10} />
                {whatsappNumber && whatsappNumber.replace(/\D/g, '').length !== 10 && <p className="text-[10px] text-destructive mt-0.5">Must be exactly 10 digits</p>}
              </div>
              <div>
                <Label className="text-xs">Phone <span className="text-muted-foreground">(10 digits)</span></Label>
                <Input value={phoneNumber} onChange={e => { const v = e.target.value.replace(/\D/g, '').slice(0, 10); setPhoneNumber(v); }} placeholder="0780000000" type="tel" inputMode="numeric" className="mt-0.5 h-9" maxLength={10} minLength={10} />
                {phoneNumber && phoneNumber.replace(/\D/g, '').length !== 10 && <p className="text-[10px] text-destructive mt-0.5">Must be exactly 10 digits</p>}
              </div>
            </div>

            <div>
              <Label className="text-xs">Email</Label>
              <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="email@example.com" type="email" className="mt-0.5 h-9" maxLength={255} />
              {email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && <p className="text-[10px] text-destructive mt-0.5">Enter a valid email</p>}
            </div>

            <div>
              <Label className="text-xs">Promised Amount (UGX) *</Label>
              <Input value={amount} onChange={e => { setAmountTouched(true); setAmount(e.target.value.replace(/[^0-9]/g, '')); }} placeholder="e.g. 500000" inputMode="numeric" className="mt-0.5 h-9" />
              {parsedAmount > 0 && (
                <div className="flex justify-between mt-1 text-[11px]">
                  <span className="text-primary font-medium">{formatUGX(parsedAmount)}</span>
                  <span className="text-emerald-600 font-medium">{earningsLine}</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Type *</Label>
                <Select value={contributionType} onValueChange={(v: 'monthly' | 'compounding') => setContributionType(v)}>
                  <SelectTrigger className="mt-0.5 h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="compounding">Compounding</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {contributionType === 'monthly' && (
                <div>
                  <Label className="text-xs">Day of month</Label>
                  <Select value={deductionDay} onValueChange={setDeductionDay}>
                    <SelectTrigger className="mt-0.5 h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 28 }, (_, i) => (
                        <SelectItem key={i + 1} value={String(i + 1)}>Day {i + 1}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {/* Available rent requests from the funding queue — always visible so
                the agent can earmark plans to the partner being added. */}
            {supportMode === 'self' ? (
              <PromissoryPlanMatcher
                targetAmount={parsedAmount}
                selectedIds={selectedPlanIds}
                onChange={setSelectedPlanIds}
                disabled={submitting}
                onSelectedTotalChange={(total) => {
                  if (amountTouched) return;
                  setAmount(total > 0 ? String(total) : '');
                }}
              />
            ) : (
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2.5 text-[11px] text-muted-foreground">
                <span className="block text-xs font-bold text-emerald-700">Auto support tenant</span>
                Welile places this partner with tenants as homes come through — no picking needed here.
              </div>
            )}


            {parsedAmount > 0 && (
              <div className="rounded-lg bg-primary/5 border border-primary/10 p-2.5 text-[11px] space-y-0.5">
                <div className="font-semibold text-primary text-xs">💰 Earnings Preview</div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Partner earns (15%/mo)</span>
                  <span className="font-medium text-emerald-600">{formatUGX(parsedAmount * 0.15)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Note validation fee</span>
                  <span className="font-bold text-primary">
                    {noteRate === null ? 'Rate unavailable' : `You earn: ${formatUGX(noteRate)} when this note is validated`}
                  </span>
                </div>
              </div>
            )}

            <Button onClick={handleSubmit} disabled={!isValid || submitting} className="w-full gap-2">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Create & Share Note
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
