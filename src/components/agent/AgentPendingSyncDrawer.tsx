import { useEffect, useRef, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Camera, PenLine, MessageSquare, ShieldCheck, WifiOff, Loader2,
  AlertCircle, Trash2, RefreshCw, CheckCircle2, Receipt, Wifi,
  Check, Circle,
} from 'lucide-react';
import { toast } from 'sonner';
import { logCollectionError } from '@/lib/logCollectionError';
import { useAuth } from '@/hooks/useAuth';
import { useOffline } from '@/contexts/OfflineContext';
import { formatUGX } from '@/lib/rentCalculations';
import { supabase } from '@/integrations/supabase/client';
import {
  listDrafts,
  attachProof,
  deleteDraft,
  updateDraft,
  type OfflineCollectionDraft,
  type ProofType,
  type TxnRefChannel,
} from '@/lib/offlineCollectionDrafts';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Per-channel reference shape rules. MUST stay in sync with the server-side
 *  TXN_REF_RULES in supabase/functions/submit-offline-collection/index.ts —
 *  Financial Ops will reject anything that doesn't match these patterns. */
const TXN_REF_PATTERNS: Record<TxnRefChannel, RegExp> = {
  mtn_momo: /^[A-Z0-9]{8,20}$/,
  airtel_money: /^[A-Z0-9.]{8,30}$/,
  momo_receipt: /^[A-Z0-9-]{6,30}$/,
  bank_transfer: /^[A-Z0-9-]{6,30}$/,
};

/** A draft can be sent to Financial Ops ONLY when it carries a fully-validated
 *  Transaction Reference proof. Photo / signature / SMS-code captures are
 *  fallbacks that block the on-device "Submit" button — the agent must come
 *  back and add a verified TXN ref before Ops will see anything. */
function isSubmittableToFinancialOps(draft: OfflineCollectionDraft): boolean {
  const p = draft.proof_bundle;
  if (!p || p.type !== 'transaction_ref') return false;
  if (!p.channel || !(p.channel in TXN_REF_PATTERNS)) return false;
  const ref = (p.reference || '').trim().toUpperCase();
  if (!ref) return false;
  return TXN_REF_PATTERNS[p.channel].test(ref);
}

export function AgentPendingSyncDrawer({ open, onOpenChange }: Props) {
  const { user } = useAuth();
  const { isOnline } = useOffline();
  const [drafts, setDrafts] = useState<OfflineCollectionDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [proofType, setProofType] = useState<ProofType>('transaction_ref');
  const [txnChannel, setTxnChannel] = useState<TxnRefChannel>('mtn_momo');
  const [txnReference, setTxnReference] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [savingProof, setSavingProof] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sigCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const items = await listDrafts(user.id);
      setDrafts(items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) refresh(); }, [open, user?.id]);

  const activeDraft = drafts.find(d => d.draft_id === activeDraftId) || null;

  const resetProofUI = () => {
    setProofType('transaction_ref');
    setTxnChannel('mtn_momo');
    setTxnReference('');
    setPayerPhone('');
    setSmsCode('');
    setPhotoDataUrl(null);
    setSignatureDataUrl(null);
  };

  const closeProofPanel = () => {
    setActiveDraftId(null);
    resetProofUI();
  };

  const handlePhotoPick = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setPhotoDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  };

  // Signature canvas helpers
  const startSig = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = true;
    const ctx = sigCanvasRef.current?.getContext('2d');
    if (!ctx) return;
    const rect = sigCanvasRef.current!.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  };
  const moveSig = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const ctx = sigCanvasRef.current?.getContext('2d');
    if (!ctx) return;
    const rect = sigCanvasRef.current!.getBoundingClientRect();
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'hsl(var(--foreground))';
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  };
  const endSig = () => {
    drawingRef.current = false;
    const dataUrl = sigCanvasRef.current?.toDataURL('image/png') || null;
    setSignatureDataUrl(dataUrl);
  };
  const clearSig = () => {
    const ctx = sigCanvasRef.current?.getContext('2d');
    if (!ctx || !sigCanvasRef.current) return;
    ctx.clearRect(0, 0, sigCanvasRef.current.width, sigCanvasRef.current.height);
    setSignatureDataUrl(null);
  };

  // Per-channel UI metadata. The validation regex itself comes from
  // TXN_REF_PATTERNS so the client and the edge function agree byte-for-byte.
  const refRules: Record<TxnRefChannel, { label: string; placeholder: string; hint: string }> = {
    mtn_momo: {
      label: 'MTN MoMo Transaction ID',
      placeholder: 'e.g. 12345678901',
      hint: 'Found in the MTN MoMo confirmation SMS — usually 10–12 digits.',
    },
    airtel_money: {
      label: 'Airtel Money Transaction ID',
      placeholder: 'e.g. AB231231.1234.A12345',
      hint: 'Found in the Airtel Money confirmation SMS.',
    },
    momo_receipt: {
      label: 'MoMo / Wallet Receipt Number',
      placeholder: 'e.g. RCP-2025-001234',
      hint: 'Receipt number printed or sent on the wallet provider receipt.',
    },
    bank_transfer: {
      label: 'Bank Reference Number',
      placeholder: 'e.g. STN240426001234',
      hint: 'Reference printed on the deposit slip or bank SMS.',
    },
  };

  const txnRefIsValid = (() => {
    const ref = txnReference.trim().toUpperCase();
    if (!ref) return false;
    return TXN_REF_PATTERNS[txnChannel].test(ref);
  })();

  const proofIsReady = (() => {
    if (proofType === 'transaction_ref') return txnRefIsValid;
    if (proofType === 'photo') return !!photoDataUrl;
    if (proofType === 'signature') return !!signatureDataUrl;
    if (proofType === 'sms_code') return /^\d{4,8}$/.test(smsCode);
    return false;
  })();

  const handleAttachProof = async () => {
    if (!activeDraft || !proofIsReady) return;
    setSavingProof(true);
    try {
      await attachProof(activeDraft.draft_id, {
        type: proofType,
        channel: proofType === 'transaction_ref' ? txnChannel : undefined,
        reference: proofType === 'transaction_ref' ? txnReference.trim().toUpperCase() : undefined,
        payer_phone: proofType === 'transaction_ref' ? (payerPhone.trim() || null) : undefined,
        photo_data_url: proofType === 'photo' ? photoDataUrl! : undefined,
        signature_data_url: proofType === 'signature' ? signatureDataUrl! : undefined,
        sms_code: proofType === 'sms_code' ? smsCode : undefined,
        captured_at: new Date().toISOString(),
      });
      toast.success('Proof attached', {
        description: 'Draft is ready to submit when you have data.',
      });
      closeProofPanel();
      await refresh();
    } catch (err: any) {
      toast.error('Could not save proof', { description: err?.message || 'Try again.' });
    } finally {
      setSavingProof(false);
    }
  };

  const handleDelete = async (draftId: string) => {
    if (!confirm('Delete this draft? This cannot be undone.')) return;
    await deleteDraft(draftId);
    await refresh();
    toast('Draft deleted');
  };

  /**
   * Submit a single draft to Financial Ops via the `submit-offline-collection`
   * edge function.
   *
   * Hard rules enforced here BEFORE the network call (the server enforces them
   * again — this is just the fast-fail path):
   *   1. Must be online. Drafts cannot be submitted from a phone with no data.
   *   2. Proof bundle MUST be `transaction_ref` with a channel + reference
   *      that match the per-channel regex. Photo / signature / SMS-code
   *      proofs are stored on-device but cannot pass this gate.
   */
  const handleSubmit = async (draft: OfflineCollectionDraft) => {
    if (!isOnline) {
      toast.error('You are offline', {
        description: 'Reconnect to data before submitting to Financial Ops.',
      });
      return;
    }
    if (!isSubmittableToFinancialOps(draft)) {
      toast.error('Transaction Reference required', {
        description:
          'Add a verified MTN/Airtel TXN ID, wallet receipt, or bank reference before submitting.',
      });
      // Auto-open the proof panel so the agent fixes it in one tap.
      resetProofUI();
      setActiveDraftId(draft.draft_id);
      return;
    }

    setSubmittingId(draft.draft_id);
    await updateDraft(draft.draft_id, { status: 'syncing', last_error: null });
    await refresh();

    try {
      const { data, error } = await supabase.functions.invoke('submit-offline-collection', {
        body: {
          draft_id: draft.draft_id,
          tenant_id: draft.tenant_id,
          rent_request_id: draft.rent_request_id,
          amount: draft.amount,
          notes: draft.notes,
          captured_at: draft.captured_at,
          provisional_receipt_no: draft.provisional_receipt_no,
          gps_lat: draft.gps_lat,
          gps_lng: draft.gps_lng,
          gps_accuracy: draft.gps_accuracy,
          proof_bundle: draft.proof_bundle,
        },
      });

      if (error || (data && (data as { error?: string }).error)) {
        const message =
          (data as { message?: string })?.message ||
          error?.message ||
          'Submission rejected by Financial Ops';
        await updateDraft(draft.draft_id, {
          status: 'rejected',
          last_error: message,
          last_attempted_at: new Date().toISOString(),
          attempts: (draft.attempts ?? 0) + 1,
        });
        logCollectionError({
          phase: 'offline_submit',
          message,
          tenantId: draft.tenant_id,
          rentRequestId: draft.rent_request_id,
          amount: draft.amount,
          context: { draft_id: draft.draft_id, attempts: (draft.attempts ?? 0) + 1 },
        });
        toast.error('Financial Ops rejected the draft', { description: message });
      } else {
        // Server accepted — clear the on-device draft. Source of truth is now
        // the server's collection record.
        await deleteDraft(draft.draft_id);
        toast.success('Submitted to Financial Ops', {
          description: `Server receipt ${(data as { server_receipt_no?: string })?.server_receipt_no || 'recorded'}`,
        });
      }
    } catch (err: any) {
      // The draft is still on the device, so no money is lost — but a sync that
      // keeps failing is a collection nobody has counted yet.
      logCollectionError({
        phase: 'sync',
        message: err?.message || 'Network error submitting an offline collection',
        tenantId: draft.tenant_id,
        rentRequestId: draft.rent_request_id,
        amount: draft.amount,
        context: { draft_id: draft.draft_id, attempts: (draft.attempts ?? 0) + 1 },
      });
      await updateDraft(draft.draft_id, {
        status: 'rejected',
        last_error: err?.message || 'Network error',
        last_attempted_at: new Date().toISOString(),
        attempts: (draft.attempts ?? 0) + 1,
      });
      toast.error('Could not submit', { description: err?.message || 'Try again.' });
    } finally {
      setSubmittingId(null);
      await refresh();
    }
  };

  const awaitingProof = drafts.filter(d => d.status === 'awaiting_proof');
  const ready = drafts.filter(d => d.status === 'ready_to_submit');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Pending Sync
          </SheetTitle>
          <p className="text-xs text-muted-foreground text-left">
            Drafts saved on this phone. They are not visible to Welile Operations until you attach proof and submit.
          </p>
        </SheetHeader>

        {!isOnline && (
          <div className="mt-3 rounded-xl bg-warning/10 border border-warning/30 p-2.5 flex items-center gap-2">
            <WifiOff className="h-4 w-4 text-warning" />
            <p className="text-[11px] text-muted-foreground">
              You're offline. You can attach proof now and submit once you have data.
            </p>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-2">
            <Badge variant="outline" className="text-[10px]">{awaitingProof.length} need proof</Badge>
            <Badge className="text-[10px] bg-primary/10 text-primary border-primary/30 hover:bg-primary/10">
              {ready.length} ready to submit
            </Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {activeDraft ? (
          /* ───── Proof capture panel ───── */
          <div className="mt-4 space-y-3">
            <div className="rounded-xl border border-border bg-muted/20 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tenant</span>
                <span className="font-semibold">{activeDraft.tenant_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-mono font-bold">{formatUGX(activeDraft.amount)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Receipt</span>
                <span className="font-mono">{activeDraft.provisional_receipt_no}</span>
              </div>
            </div>

            {/* ═══ Pending Proof — Transaction Reference (PROMINENT) ═══ */}
            <button
              type="button"
              onClick={() => setProofType('transaction_ref')}
              className={`w-full rounded-2xl border-2 p-4 text-left transition-all ${
                proofType === 'transaction_ref'
                  ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
                  : 'border-primary/40 bg-primary/5 hover:border-primary/70'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="h-11 w-11 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
                  <Receipt className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-sm">Transaction Reference</p>
                    <Badge className="text-[9px] bg-primary text-primary-foreground hover:bg-primary uppercase tracking-wide">
                      Required
                    </Badge>
                    {!isOnline && (
                      <Badge variant="outline" className="text-[9px] gap-1 border-warning/40 text-warning">
                        <WifiOff className="h-2.5 w-2.5" /> capture now, verify online
                      </Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                    MTN MoMo / Airtel Money TXN ID, wallet receipt number, or bank reference. The strongest proof Financial Ops accepts.
                  </p>
                </div>
              </div>
            </button>

            <div>
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Or fall-back proof</Label>
              <div className="grid grid-cols-3 gap-2 mt-1.5">
                <Button
                  type="button" variant={proofType === 'photo' ? 'default' : 'outline'}
                  onClick={() => setProofType('photo')} className="h-14 flex-col gap-0.5"
                >
                  <Camera className="h-4 w-4" /><span className="text-[10px]">Photo</span>
                </Button>
                <Button
                  type="button" variant={proofType === 'signature' ? 'default' : 'outline'}
                  onClick={() => setProofType('signature')} className="h-14 flex-col gap-0.5"
                >
                  <PenLine className="h-4 w-4" /><span className="text-[10px]">Signature</span>
                </Button>
                <Button
                  type="button" variant={proofType === 'sms_code' ? 'default' : 'outline'}
                  onClick={() => setProofType('sms_code')} className="h-14 flex-col gap-0.5"
                >
                  <MessageSquare className="h-4 w-4" /><span className="text-[10px]">SMS Code</span>
                </Button>
              </div>
            </div>

            {proofType === 'transaction_ref' && (
              <div className="rounded-2xl border-2 border-primary/30 bg-primary/[0.03] p-3 space-y-3">
                <div className="flex items-center gap-1.5 text-[11px] text-primary font-semibold">
                  <Wifi className="h-3.5 w-3.5" />
                  Capture the reference exactly as it appears in the SMS or receipt
                </div>

                {/* ─── Live submission checklist ─────────────────────────────
                    Every item must turn green before Financial Ops will
                    accept the draft. We surface the rules the edge function
                    enforces so the agent never has to guess what's wrong. */}
                {(() => {
                  const refTrim = txnReference.trim().toUpperCase();
                  const checks = [
                    { key: 'channel', label: 'Channel selected (MTN, Airtel, Receipt or Bank)', ok: !!txnChannel },
                    { key: 'ref-present', label: `${refRules[txnChannel].label} entered`, ok: refTrim.length > 0 },
                    { key: 'ref-format', label: `Matches expected format for ${refRules[txnChannel].label}`, ok: txnRefIsValid },
                  ] as const;
                  const passed = checks.filter(c => c.ok).length;
                  const allOk = passed === checks.length;
                  return (
                    <div
                      className={`rounded-xl border p-2.5 ${
                        allOk
                          ? 'border-success/40 bg-success/5'
                          : 'border-warning/40 bg-warning/5'
                      }`}
                      role="status"
                      aria-live="polite"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <p className={`text-[10px] uppercase tracking-wider font-bold ${
                          allOk ? 'text-success' : 'text-warning'
                        }`}>
                          Submission checklist
                        </p>
                        <Badge
                          variant="outline"
                          className={`text-[9px] ${
                            allOk
                              ? 'border-success/40 text-success'
                              : 'border-warning/40 text-warning'
                          }`}
                        >
                          {passed}/{checks.length} passed
                        </Badge>
                      </div>
                      <ul className="space-y-1">
                        {checks.map(c => (
                          <li
                            key={c.key}
                            className={`flex items-start gap-2 text-[11px] leading-snug ${
                              c.ok ? 'text-success' : 'text-muted-foreground'
                            }`}
                          >
                            {c.ok ? (
                              <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            ) : (
                              <Circle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
                            )}
                            <span className={c.ok ? 'line-through opacity-80' : 'font-medium'}>
                              {c.label}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {!allOk && (
                        <p className="text-[10px] text-muted-foreground mt-1.5 pt-1.5 border-t border-warning/20">
                          Financial Ops will <span className="font-bold text-warning">reject</span> this draft until every item above is green.
                        </p>
                      )}
                    </div>
                  );
                })()}

                <div>
                  <Label className="text-xs">Channel</Label>
                  <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                    {([
                      { id: 'mtn_momo' as const, label: 'MTN MoMo' },
                      { id: 'airtel_money' as const, label: 'Airtel Money' },
                      { id: 'momo_receipt' as const, label: 'MoMo Receipt' },
                      { id: 'bank_transfer' as const, label: 'Bank Transfer' },
                    ]).map(opt => (
                      <Button
                        key={opt.id}
                        type="button"
                        variant={txnChannel === opt.id ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => { setTxnChannel(opt.id); setTxnReference(''); }}
                        className="h-9 text-xs"
                      >
                        {opt.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div>
                  <Label className="text-xs">{refRules[txnChannel].label}</Label>
                  <Input
                    value={txnReference}
                    onChange={(e) => setTxnReference(e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 30))}
                    placeholder={refRules[txnChannel].placeholder}
                    className="h-12 text-base font-mono font-bold tracking-wide mt-1"
                    autoCapitalize="characters"
                    spellCheck={false}
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">{refRules[txnChannel].hint}</p>
                  {txnReference && !txnRefIsValid && (
                    <p className="text-[10px] text-destructive mt-1 flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" /> Reference format doesn't match {refRules[txnChannel].label}.
                    </p>
                  )}
                </div>

                <div>
                  <Label className="text-xs">Sender phone (optional)</Label>
                  <Input
                    value={payerPhone}
                    onChange={(e) => setPayerPhone(e.target.value.replace(/[^\d+]/g, '').slice(0, 16))}
                    placeholder="07xx xxx xxx"
                    inputMode="tel"
                    className="h-10 mt-1"
                  />
                </div>
              </div>
            )}

            {proofType === 'photo' && (
              <div className="space-y-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handlePhotoPick(f);
                  }}
                />
                {photoDataUrl ? (
                  <div className="rounded-xl overflow-hidden border border-border">
                    <img src={photoDataUrl} alt="Proof" className="w-full max-h-64 object-cover" />
                    <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} className="w-full rounded-none">
                      Retake
                    </Button>
                  </div>
                ) : (
                  <Button variant="outline" onClick={() => fileInputRef.current?.click()} className="w-full h-24 border-dashed">
                    <Camera className="h-5 w-5 mr-2" /> Take photo of cash + tenant
                  </Button>
                )}
              </div>
            )}

            {proofType === 'signature' && (
              <div className="space-y-2">
                <div className="rounded-xl border border-dashed border-border bg-background">
                  <canvas
                    ref={sigCanvasRef}
                    width={400}
                    height={160}
                    className="w-full touch-none"
                    onPointerDown={startSig}
                    onPointerMove={moveSig}
                    onPointerUp={endSig}
                    onPointerLeave={endSig}
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={clearSig} className="flex-1">Clear</Button>
                  <p className="text-[10px] text-muted-foreground self-center flex-1 text-right">
                    Tenant signs above
                  </p>
                </div>
              </div>
            )}

            {proofType === 'sms_code' && (
              <div className="space-y-2">
                <Label className="text-xs">SMS code from tenant</Label>
                <Input
                  value={smsCode}
                  onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  placeholder="123456"
                  inputMode="numeric"
                  className="h-12 text-center text-lg font-mono font-bold tracking-widest"
                />
                <p className="text-[10px] text-muted-foreground">
                  Ask the tenant to forward the SMS confirmation code Welile sent them.
                </p>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" onClick={closeProofPanel} className="flex-1" disabled={savingProof}>
                Cancel
              </Button>
              <Button
                onClick={handleAttachProof}
                disabled={!proofIsReady || savingProof}
                className="flex-1 font-bold"
              >
                {savingProof ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Attach Proof'}
              </Button>
            </div>
          </div>
        ) : (
          /* ───── Draft list ───── */
          <div className="mt-4 space-y-2">
            {drafts.length === 0 && !loading && (
              <div className="text-center py-10 text-muted-foreground text-sm">
                <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-success/50" />
                No drafts on this device.
              </div>
            )}

            {drafts.map(draft => (
              <div key={draft.draft_id} className="rounded-xl border border-border bg-card p-3 space-y-2">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-semibold text-sm">{draft.tenant_name}</p>
                    <p className="text-[11px] text-muted-foreground font-mono">
                      {draft.provisional_receipt_no} · {relativeTime(draft.captured_at)}
                    </p>
                  </div>
                  <p className="font-mono font-bold text-sm">{formatUGX(draft.amount)}</p>
                </div>

                {draft.status === 'awaiting_proof' && (
                  <div className="flex items-center gap-1.5 text-[11px] text-warning">
                    <AlertCircle className="h-3 w-3" /> Needs proof before submission
                  </div>
                )}
                {draft.status === 'ready_to_submit' && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-[11px] text-primary">
                      <ShieldCheck className="h-3 w-3" />
                      {draft.proof_bundle?.type === 'transaction_ref'
                        ? <>TXN ref: <span className="font-mono font-bold">{draft.proof_bundle.reference}</span></>
                        : <>Proof attached ({draft.proof_bundle?.type})</>}
                    </div>
                    {!isSubmittableToFinancialOps(draft) && (
                      <div className="flex items-center gap-1.5 text-[11px] text-warning">
                        <AlertCircle className="h-3 w-3" />
                        Transaction Reference required before Financial Ops will accept this.
                      </div>
                    )}
                  </div>
                )}
                {draft.status === 'syncing' && (
                  <div className="flex items-center gap-1.5 text-[11px] text-primary">
                    <Loader2 className="h-3 w-3 animate-spin" /> Submitting to Financial Ops…
                  </div>
                )}
                {draft.status === 'rejected' && draft.last_error && (
                  <div className="text-[11px] text-destructive">{draft.last_error}</div>
                )}

                <div className="flex gap-2 pt-1">
                  {draft.status === 'awaiting_proof' && (
                    <Button
                      size="sm" className="flex-1"
                      onClick={() => { resetProofUI(); setActiveDraftId(draft.draft_id); }}
                    >
                      Add Proof
                    </Button>
                  )}
                  {draft.status === 'ready_to_submit' && (
                    isSubmittableToFinancialOps(draft) ? (
                      <Button
                        size="sm"
                        className="flex-1 font-bold"
                        onClick={() => handleSubmit(draft)}
                        disabled={!isOnline || submittingId === draft.draft_id}
                      >
                        {submittingId === draft.draft_id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : !isOnline ? (
                          <><WifiOff className="h-3.5 w-3.5 mr-1" /> Offline</>
                        ) : (
                          'Submit to Financial Ops'
                        )}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 border-warning/40 text-warning hover:text-warning"
                        onClick={() => { resetProofUI(); setActiveDraftId(draft.draft_id); }}
                      >
                        Add Transaction Reference
                      </Button>
                    )
                  )}
                  {draft.status === 'rejected' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => { resetProofUI(); setActiveDraftId(draft.draft_id); }}
                    >
                      Fix &amp; retry
                    </Button>
                  )}
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => handleDelete(draft.draft_id)}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}