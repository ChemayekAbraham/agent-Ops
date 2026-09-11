import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertOctagon, Loader2, Upload, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  beginAuthCriticalSection,
  endAuthCriticalSection,
  armAuthCriticalSection,
  disarmAuthCriticalSection,
} from '@/lib/staleSessionDetector';

interface ProoflessRow {
  id: string;
  user_id: string | null;
  amount: number;
  payout_method: string | null;
  mobile_money_provider: string | null;
  processed_at: string | null;
  created_at: string;
  full_name?: string | null;
  phone?: string | null;
}

/**
 * Full-page blocking overlay for merchant agents.
 *
 * Only payouts this user actually settled AS THE CASH-OUT MERCHANT count:
 * the request must have been assigned to them, claimed by them, or carry them
 * as the paying agent. Payouts they merely processed or verified in a Financial
 * Ops / manager capacity (someone else moved the money) are NOT their proof
 * obligation and must never block them. Proof is uploaded to the private
 * `payment-proofs` bucket and attached via a guarded RPC.
 */
export function ProoflessPayoutBlocker() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  // Mobile browsers (especially iOS Safari) frequently discard the page while
  // the camera/file picker is open. Any React state captured before the picker
  // opened is gone when the app comes back, which is why the upload silently
  // did nothing. We therefore (a) use one native <label>+<input> per row so the
  // file arrives with its own row id — no state hand-off at all — and (b) leave
  // a sessionStorage breadcrumb so that if the page really was reloaded we tell
  // the merchant to pick the file again instead of failing silently.
  const PENDING_KEY = 'welile.proofUploadPending';
  const uploadingRef = useRef(false);

  useEffect(() => {
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (pending) {
      sessionStorage.removeItem(PENDING_KEY);
      toast.warning('Upload interrupted', {
        description: 'Your phone reloaded the app while picking the file. Please attach the proof again.',
      });
    }
  }, []);

  const { data: rows = [] } = useQuery({
    queryKey: ['merchant-proofless-payouts', user?.id],
    enabled: !!user?.id,
    refetchInterval: 60_000,
    queryFn: async (): Promise<ProoflessRow[]> => {
      const me = user!.id;
      // `assigned_cashout_agent_id` stores the cashout_agents.id row, not the
      // user id — resolve it first so the settlement match below compares like
      // with like (comparing it directly against `me` never matched anything).
      const { data: myAgentRow } = await supabase
        .from('cashout_agents')
        .select('id')
        .eq('agent_id', me)
        .maybeSingle();
      const myCashoutAgentId = myAgentRow?.id ?? null;

      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select(
          'id, user_id, amount, payout_method, mobile_money_provider, processed_at, created_at, payout_proof, assigned_cashout_agent_id, processed_by, fin_ops_verified_by, fin_ops_approved_by',
        )
        // Settled by this user acting as the cash-out merchant — not merely
        // processed/approved by them on someone else's payout. `processed_by`
        // is the authoritative "who actually settled this" stamp; a claim that
        // was later released and settled by someone else must never count
        // against the merchant who only accepted (and lost) the dispatch.
        .or(
          myCashoutAgentId
            ? `assigned_cashout_agent_id.eq.${myCashoutAgentId},processed_by.eq.${me}`
            : `processed_by.eq.${me}`,
        )
        .eq('status', 'completed')
        .is('payout_proof_path', null)
        .order('processed_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      const list = ((data as any[]) || []).filter((r) => {
        if (String(r.payout_proof ?? '').trim()) return false;
        // Belt and braces: the merchant must genuinely be the one who settled it.
        const isPayer =
          (myCashoutAgentId && r.assigned_cashout_agent_id === myCashoutAgentId) ||
          r.processed_by === me;
        if (!isPayer) return false;
        // Financial Ops / manager verification of a payout someone else paid is
        // not a merchant settlement, so it carries no proof obligation here.
        const verifiedAsOps = r.fin_ops_verified_by === me || r.fin_ops_approved_by === me;
        return !verifiedAsOps;
      });
      const ids = Array.from(new Set(list.map((r) => r.user_id).filter(Boolean))) as string[];
      let names = new Map<string, { full_name: string | null; phone: string | null }>();
      if (ids.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        names = new Map((profs || []).map((p: any) => [p.id, { full_name: p.full_name, phone: p.phone }]));
      }
      return list.map((r) => ({
        ...r,
        amount: Number(r.amount || 0),
        full_name: r.user_id ? names.get(r.user_id)?.full_name ?? null : null,
        phone: r.user_id ? names.get(r.user_id)?.phone ?? null : null,
      })) as ProoflessRow[];
    },
  });

  async function handleFile(id: string, file: File) {
    if (!id || uploadingRef.current) return;
    uploadingRef.current = true;
    setBusyId(id);
    // Returning from the camera can resume the page with a momentarily expired
    // token; suppress forced sign-out until the proof is attached.
    beginAuthCriticalSection();
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${user!.id}/payout-proofs/${id}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('payment-proofs')
        .upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (upErr) throw new Error(upErr.message || 'Failed to upload proof.');
      const { error } = await (supabase as any).rpc('merchant_attach_payout_proof', {
        p_withdrawal_id: id,
        p_path: path,
        p_bucket: 'payment-proofs',
        p_type: file.type || `image/${ext}`,
      });
      if (error) throw error;
      sessionStorage.removeItem(PENDING_KEY);
      toast.success('Proof attached — thank you.');
      qc.invalidateQueries({ queryKey: ['merchant-proofless-payouts'] });
    } catch (e: any) {
      toast.error(e?.message || 'Could not attach the proof');
    } finally {
      endAuthCriticalSection();
      disarmAuthCriticalSection();
      uploadingRef.current = false;
      setBusyId(null);
    }
  }

  // TEMPORARILY DISABLED at Josh's request during rush-hour partner ROI
  // payouts (2026-09-11) — the underlying settlement-matching bug is fixed,
  // but is_verified/is_approved self-stamping still exempts ~99.8% of
  // self-settled payouts platform-wide, so this gate needs a compliance
  // policy decision before it blocks merchants again. Re-enable by deleting
  // this early return once that's settled.
  return null;
  // eslint-disable-next-line no-unreachable
  if (rows.length === 0) return null;

  const total = rows.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="fixed inset-0 z-[80] bg-background/95 backdrop-blur-sm overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl p-4 sm:p-6 space-y-4">
        <div className="rounded-2xl border-2 border-destructive bg-destructive/10 p-4 flex items-start gap-3">
          <AlertOctagon className="h-7 w-7 text-destructive shrink-0 mt-0.5 animate-pulse" />
          <div className="space-y-1">
            <p className="text-lg font-extrabold text-destructive">
              PROOF MISSING ON {rows.length} WALLET DEDUCTION{rows.length > 1 ? 'S' : ''}
            </p>
            <p className="text-xs text-destructive/80">
              These customers had {formatUGX(total)} taken off their wallet but you never attached
              proof of payment. Attach proof for each one to unlock your payout dashboard. Financial
              Ops and the CFO can see this list.
            </p>
          </div>
        </div>

        <ul className="space-y-3 list-none p-0 m-0">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border border-destructive/40 bg-card p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold truncate">{r.full_name || 'Unnamed customer'}</p>
                  <p className="text-xs text-muted-foreground">{r.phone || 'No phone on file'}</p>
                </div>
                <Badge variant="destructive" className="shrink-0">No proof</Badge>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{formatUGX(r.amount)}</span>
                <span>
                  {r.payout_method || r.mobile_money_provider || 'payout'} •{' '}
                  {format(new Date(r.processed_at || r.created_at), 'MMM d • h:mm a')}
                </span>
              </div>
              <label
                htmlFor={`proof-input-${r.id}`}
                aria-disabled={busyId === r.id}
                className={`flex w-full items-center justify-center gap-2 rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground ${
                  busyId === r.id ? 'pointer-events-none opacity-70' : 'cursor-pointer hover:bg-destructive/90'
                }`}
              >
                {busyId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {busyId === r.id ? 'Uploading proof…' : 'Attach proof of payment'}
              </label>
              <input
                id={`proof-input-${r.id}`}
                type="file"
                accept="image/*,application/pdf"
                className="sr-only"
                disabled={busyId === r.id}
                onClick={() => {
                  sessionStorage.setItem(PENDING_KEY, r.id);
                  // Camera/gallery is opening — hold the session through the
                  // background/resume cycle that follows.
                  armAuthCriticalSection(180_000);
                }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void handleFile(r.id, f);
                  else {
                    sessionStorage.removeItem(PENDING_KEY);
                    disarmAuthCriticalSection();
                  }
                }}
              />
            </li>
          ))}
        </ul>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
          Every settled payout must carry proof. If you cannot produce proof for a customer, refund
          them and contact Financial Ops immediately.
        </p>
      </div>
    </div>
  );
}
