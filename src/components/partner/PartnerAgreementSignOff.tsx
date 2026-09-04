import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { buildPartnerReference } from '@/lib/partnerReference';
import AgreementHtmlPreview, { type AgreementPreviewData } from './AgreementHtmlPreview';
import { buildAgreementHtml } from './agreementTemplate';
import { renderAgreementPdfBase64 } from './renderAgreementPdf';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Loader2, Mail, Phone, FileSignature, CheckCircle2, ShieldCheck, Upload } from 'lucide-react';

export interface SignOffPartner {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
}

// Read-only sign-off review. The admin fills in NOTHING — every partner field
// is rendered from the single source-of-truth `partner_agreements` row the
// partner supplied at onboarding, and Welile's counter-signature comes from the
// stored `partner_agreement_company_defaults`. A single action calls the
// server-side `generate-partner-agreement` edge function with `countersign:true`.
export default function PartnerAgreementSignOff({
  open,
  onOpenChange,
  partner,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  partner: SignOffPartner | null;
}) {
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agreement, setAgreement] = useState<any | null>(null);
  // True when no `partner_agreements` row exists yet — we build a draft from the
  // profile + saved payout method so counter-signing still works (the edge
  // function backfills the real row server-side on countersign).
  const [isDraft, setIsDraft] = useState(false);
  const [defaults, setDefaults] = useState<any | null>(null);
  const [repSigUrl, setRepSigUrl] = useState<string | undefined>();
  const [missing, setMissing] = useState<string | null>(null);

  // Admin-entered counter-signature details (filled before sending).
  const [repName, setRepName] = useState('');
  const [repPosition, setRepPosition] = useState('');
  const [repContact, setRepContact] = useState('');
  const [sigDataUrl, setSigDataUrl] = useState<string | undefined>();
  // Editable stamp / execution date shown on the contract and the Welile stamp.
  const [stampDate, setStampDate] = useState<string>('');
  // Editable partnership amount printed on the contract. Prefilled from the
  // agreement row, falling back to the partner's portfolio total when the
  // stored snapshot is empty/zero (legacy rows captured before the amount).
  const [amountInput, setAmountInput] = useState<string>('');

  useEffect(() => {
    if (!open || !partner) return;
    let cancelled = false;
    setLoading(true);
    setMissing(null);
    setAgreement(null);
    setIsDraft(false);
    (async () => {
      try {
        const [{ data: ag, error: agErr }, { data: def }, { data: pfAll }] = await Promise.all([
          supabase
            .from('partner_agreements')
            .select('*')
            .eq('partner_id', partner.id)
            .maybeSingle(),
          supabase
            .from('partner_agreement_company_defaults')
            .select('*')
            .limit(1)
            .maybeSingle(),
          supabase.from('investor_portfolios').select('investment_amount').eq('investor_id', partner.id),
        ]);
        if (cancelled) return;
        if (agErr) throw agErr;
        const portfolioTotal = (pfAll || []).reduce((s: number, r: any) => s + (Number(r.investment_amount) || 0), 0);
        if (!ag) {
          // Build a draft agreement from the profile + saved payout method so the
          // stamp date, rep fields and preview all render. The record is created
          // when the admin counter-signs.
          const [{ data: prof }, { data: method }] = await Promise.all([
            supabase.from('profiles').select('full_name, phone, email, national_id, landmark').eq('id', partner.id).maybeSingle(),
            supabase.from('saved_payout_methods').select('*').eq('user_id', partner.id)
              .order('is_default', { ascending: false })
              .limit(1).maybeSingle(),
          ]);
          if (cancelled) return;
          const total = portfolioTotal;
          setIsDraft(true);
          setMissing(null);
          setAgreement({
            full_name: prof?.full_name || partner.full_name,
            phone: prof?.phone || partner.phone,
            email: prof?.email || partner.email,
            national_id: prof?.national_id || '',
            address: prof?.landmark || '',
            partnership_amount: total,
            payout_mode: method?.payout_mode || 'bank',
            bank_name: method?.bank_name || '',
            bank_account_name: method?.bank_account_name || '',
            bank_account_number: method?.bank_account_number || '',
            momo_provider: method?.momo_provider || '',
            momo_number: method?.momo_number || '',
            momo_name: method?.momo_name || '',
            kin_name: '',
            kin_contact: '',
            reference: buildPartnerReference(partner.id, partner.created_at),
            status: 'pending',
          });
        } else {
          setAgreement(ag);
        }
        setDefaults(def || null);
        if (def?.signature_path) {
          const { data: sig } = await supabase.storage
            .from('partner-agreements')
            .createSignedUrl(def.signature_path, 60 * 60);
          if (!cancelled) setRepSigUrl(sig?.signedUrl || undefined);
        } else {
          setRepSigUrl(undefined);
        }
        // Prefill the editable fields from stored defaults (admin can override).
        if (!cancelled) {
          setRepName(def?.rep_name || '');
          setRepPosition(def?.rep_position || '');
          setRepContact(def?.rep_contact || '');
          setSigDataUrl(undefined);
          const storedAmount = Number(ag?.partnership_amount) || 0;
          const effectiveAmount = storedAmount > 0 ? storedAmount : portfolioTotal;
          setAmountInput(effectiveAmount > 0 ? String(effectiveAmount) : '');
          const base = ag?.countersigned_at ? new Date(ag.countersigned_at) : new Date();
          setStampDate(
            `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`,
          );
        }
      } catch (e: any) {
        if (!cancelled) setMissing(e?.message || 'Could not load the agreement.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, partner]);

  const previewData: AgreementPreviewData | null = useMemo(() => {
    if (!agreement) return null;
    return {
      // Prefer the profile's full legal name over the agreement snapshot.
      // Some legacy `partner_agreements` rows were captured with initials
      // (e.g. "RP RP") from an early onboarding form; the profile is the
      // authoritative source and matches what appears elsewhere in the app.
      partnerName: (partner?.full_name?.trim() || agreement.full_name?.trim() || ''),
      partnerId: agreement.national_id || '',
      partnerAddress: agreement.address || '',
      partnerPhone: agreement.phone || partner?.phone || '',
      partnerEmail: agreement.email || partner?.email || '',
      partnershipAmount: Number(amountInput) || Number(agreement.partnership_amount) || 0,
      payoutMode: agreement.payout_mode === 'momo' ? 'momo' : 'bank',
      bankName: agreement.bank_name || '',
      bankAccountName: agreement.bank_account_name || '',
      bankAccountNumber: agreement.bank_account_number || '',
      momoProvider: agreement.momo_provider || '',
      momoNumber: agreement.momo_number || '',
      momoName: agreement.momo_name || '',
      kinName: agreement.kin_name || '',
      kinContact: agreement.kin_contact || '',
      agreementDate: (() => {
        if (stampDate) {
          const [y, m, d] = stampDate.split('-').map(Number);
          if (y && m && d) return new Date(y, m - 1, d);
        }
        return agreement.countersigned_at ? new Date(agreement.countersigned_at) : new Date();
      })(),
      welileRepName: repName,
      welileRepPosition: repPosition,
      welileRepContact: repContact,
      welileSignatureDataUrl: sigDataUrl || repSigUrl,
      // Render the partner's handwritten signature captured at onboarding
      // (persisted on partner_agreements) rather than falling back to the
      // italic typed name.
      partnerSignatureDataUrl: agreement.partner_signature_data_url || undefined,
      includeStamp: true,
    };
  }, [agreement, partner, repSigUrl, repName, repPosition, repContact, sigDataUrl, stampDate, amountInput]);

  const onSignatureFile = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Use an image file', description: 'Upload a PNG or JPG of the signature.', variant: 'destructive' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setSigDataUrl(typeof reader.result === 'string' ? reader.result : undefined);
    reader.readAsDataURL(file);
  };

  const handleCountersign = async () => {
    if (!partner) return;
    const hasSignature = !!sigDataUrl || !!defaults?.signature_path;
    if (!repName.trim() || !hasSignature) {
      toast({
        title: 'Complete the sign-off details',
        description: 'Enter the representative name and add a signature image before counter-signing.',
        variant: 'destructive',
      });
      return;
    }
    if (!previewData) {
      toast({ title: 'Agreement not loaded', description: 'Wait for the agreement to load, then try again.', variant: 'destructive' });
      return;
    }
    setBusy(true);
    try {
      // Render the executed PDF from the EXACT same HTML shown in the preview so
      // the stored/emailed document is pixel-identical to what the admin saw.
      const storedStamp = agreement?.countersigned_at
        ? new Date(agreement.countersigned_at).toISOString().slice(0, 10)
        : '';
      // A changed stamp date must land in the stored/emailed PDF, so re-render
      // instead of resending the previously stored file.
      const stampChanged = !!stampDate && stampDate !== storedStamp;
      // Same for an edited partnership amount — the stored PDF is stale.
      const amountChanged =
        (Number(amountInput) || 0) !== (Number(agreement?.partnership_amount) || 0);
      if (alreadySigned && !stampChanged && !amountChanged) {
        const { data, error } = await supabase.functions.invoke('resend-partner-agreement-email', {
          body: { partnerId: partner.id },
        });
        if (error) throw error;
        if (data?.results?.partner?.reason === 'email_suppressed') {
          toast({
            title: 'Partnership copy sent',
            description: `${partner.email || 'Partner email'} is blocked from a prior bounce, so a copy was sent directly to partnership@welile.com.`,
          });
        } else {
          toast({
            title: 'Agreement re-sent',
            description: partner.email ? `Executed PDF emailed to ${partner.email} and partnership@welile.com.` : 'Executed PDF sent to partnership@welile.com.',
          });
        }
      } else {
        const pdfBase64 = await renderAgreementPdfBase64(buildAgreementHtml(previewData));
        const { error } = await supabase.functions.invoke('generate-partner-agreement', {
          body: {
            partnerId: partner.id,
            countersign: true,
            pdfBase64,
            countersignAt: stampDate || undefined,
            rep: {
              name: repName.trim(),
              position: repPosition.trim(),
              contact: repContact.trim(),
              signatureBase64: sigDataUrl || undefined,
            },
          },
        });
        if (error) throw error;
        toast({
          title: 'Agreement counter-signed & sent',
          description: partner.email ? `Executed PDF emailed to ${partner.email}.` : 'Executed PDF stored.',
        });
      }
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: 'Could not counter-sign', description: e?.message || 'Try again.', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  if (!partner) return null;

  const alreadySigned = !!agreement?.countersigned_at || agreement?.status === 'countersigned';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-w-6xl w-[97vw] h-[94vh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileSignature className="h-4 w-4 text-primary" /> Partnership Agreement — Sign-off
          </DialogTitle>
          <DialogDescription className="text-xs">
            Review the partner's submitted details, fill in the Welile counter-signature fields and signature image,
            then counter-sign &amp; send. The partner's details are rendered from their onboarding record.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[360px_1fr]">
          {/* LEFT — read-only summary + single action */}
          <div className="border-r overflow-y-auto p-4 space-y-4 bg-muted/20">
            <div className="rounded-xl bg-background border p-3 space-y-1">
              <p className="text-sm font-bold">{partner.full_name || agreement?.full_name || 'Unknown partner'}</p>
              <p className="text-[11px] font-mono text-muted-foreground">
                Ref: {agreement?.reference || buildPartnerReference(partner.id, partner.created_at)}
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{partner.phone || '—'}</span>
                {partner.email && <span className="truncate">{partner.email}</span>}
              </div>
            </div>

            {loading && (
              <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading agreement on file…
              </p>
            )}

            {missing && !loading && (
              <p className="text-xs text-destructive">{missing}</p>
            )}

            {agreement && !loading && (
              <>
                {isDraft && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-800">
                    No agreement record on file yet — details below are drawn from the partner's profile and
                    payout method. Counter-signing creates the agreement record and stores the executed PDF.
                  </div>
                )}
                <section className="space-y-1.5">
                  <p className="text-xs font-semibold text-foreground">{isDraft ? 'Partner details (from profile)' : 'Partner submitted'}</p>
                  <ReadRow
                    label="Partnership amount"
                    value={`UGX ${(Number(amountInput) || Number(agreement.partnership_amount) || 0).toLocaleString('en-US')}`}
                  />
                  <ReadRow label="National ID / Passport" value={agreement.national_id || '—'} />
                  <ReadRow label="Address" value={agreement.address || '—'} />
                  <ReadRow
                    label="Payout"
                    value={agreement.payout_mode === 'momo'
                      ? [agreement.momo_provider, agreement.momo_number].filter(Boolean).join(' ') || 'Mobile money'
                      : [agreement.bank_name, agreement.bank_account_number].filter(Boolean).join(' ') || 'Bank'}
                  />
                  <ReadRow label="Next of kin" value={[agreement.kin_name, agreement.kin_contact].filter(Boolean).join(' · ') || '—'} />
                </section>

                <Separator />

                <section className="space-y-2.5">
                  <p className="text-xs font-semibold text-primary">Welile counter-signature</p>
                  <p className="text-[10px] text-muted-foreground -mt-1">
                    Fill in the details below before counter-signing. They render live in the preview.
                  </p>
                  <div className="space-y-1">
                    <Label className="text-[11px]">Partnership amount (UGX)</Label>
                    <Input
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)}
                      placeholder="e.g. 5000000"
                      className="h-8 text-xs"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Prefilled from the partner's record (or their portfolio total when the record is blank).
                      Changing it updates the contract and re-sends the executed PDF.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">Representative name</Label>
                    <Input value={repName} onChange={(e) => setRepName(e.target.value)} placeholder="e.g. Jane Doe" className="h-8 text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">Position</Label>
                    <Input value={repPosition} onChange={(e) => setRepPosition(e.target.value)} placeholder="e.g. Director" className="h-8 text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">Contact</Label>
                    <Input value={repContact} onChange={(e) => setRepContact(e.target.value)} placeholder="Phone or email" className="h-8 text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">Stamp / execution date</Label>
                    <Input
                      type="date"
                      value={stampDate}
                      onChange={(e) => setStampDate(e.target.value)}
                      className="h-8 text-xs"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Sets the date printed on the contract and the Welile stamp. Changing it re-renders and re-sends the executed PDF.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">Signature image</Label>
                    <div className="flex items-center gap-2">
                      <Button asChild variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                        <label className="cursor-pointer">
                          <Upload className="h-3.5 w-3.5" /> Upload
                          <input type="file" accept="image/*" className="hidden" onChange={(e) => onSignatureFile(e.target.files?.[0])} />
                        </label>
                      </Button>
                      {(sigDataUrl || repSigUrl) ? (
                        <img src={sigDataUrl || repSigUrl} alt="Signature" className="h-8 max-w-[120px] object-contain border rounded bg-card" />
                      ) : (
                        <span className="text-[10px] text-amber-600">No signature yet</span>
                      )}
                    </div>
                  </div>
                </section>

                <Separator />

                <div className="flex flex-col gap-2 pb-2">
                  {alreadySigned ? (
                    <>
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700 inline-flex items-center gap-1.5">
                        <CheckCircle2 className="h-4 w-4" /> Already counter-signed
                        {agreement.countersigned_at ? ` on ${new Date(agreement.countersigned_at).toLocaleDateString()}` : ''}.
                      </div>
                      <Button
                        variant="outline"
                        onClick={handleCountersign}
                        disabled={busy || !repName.trim() || !(sigDataUrl || defaults?.signature_path)}
                        className="gap-1.5"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                        Re-send executed agreement
                      </Button>
                      <p className="text-[10px] text-muted-foreground">
                        Use this if the partner says they never received it — regenerates the executed PDF and emails it again.
                      </p>
                    </>
                  ) : (
                    <Button onClick={handleCountersign} disabled={busy || !repName.trim() || !(sigDataUrl || defaults?.signature_path)} className="gap-1.5">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                      Counter-sign &amp; send
                    </Button>
                  )}
                  <p className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                    <Mail className="h-3 w-3" /> Generates the executed PDF server-side and emails the partner.
                  </p>
                </div>
              </>
            )}
          </div>

          {/* RIGHT — live preview */}
          <div className="overflow-y-auto bg-muted p-3 sm:p-6">
            <div className="mx-auto max-w-[760px] bg-card shadow-lg rounded-sm">
              {previewData ? (
                <AgreementHtmlPreview data={previewData} />
              ) : (
                <div className="p-10 text-center text-sm text-muted-foreground">No agreement to preview.</div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-medium text-foreground text-right break-words">{value}</span>
    </div>
  );
}
