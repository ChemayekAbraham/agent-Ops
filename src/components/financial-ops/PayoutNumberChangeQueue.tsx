/**
 * Withdrawal number changes waiting on Financial Ops.
 *
 * Approving here is what actually moves a person's locked withdrawal number, and it also opens their payouts again.
 * Every decision needs a written basis and is recorded against the person's account.
 *
 * Layout: the list of requests on the left, the selected request in the middle (who, what changes, the system check,
 * who to call), and the required ownership check and decision on the right. The rules are unchanged: approving needs
 * the tick, a 25-character proof statement, a 10-character reason and an allowed system check; rejecting needs the reason.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertCircle, ArrowUpDown, Calendar, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, IdCard, Info, List, Loader2,
  Lock, Phone, Shield, Wallet, XCircle,
} from 'lucide-react';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useDecideNumberChange,
  useNumberChangeQueue,
  useNumberChangeVetting,
  type NumberChangeRequest,
} from '@/hooks/usePayoutNumberChange';

/** Loose name comparison, only to flag an obvious mismatch for the reviewer. */
function namesLookAlike(a?: string | null, b?: string | null) {
  const parts = (v?: string | null) =>
    (v ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const x = parts(a);
  const y = parts(b);
  if (!x.length || !y.length) return false;
  return x.some((w) => y.includes(w));
}

const last3 = (n?: string | null) => (n ?? '').replace(/\D/g, '').slice(-3);
const maskId = (n?: string | null) => (n && n.length > 4 ? `${n.slice(0, 2)}${'•'.repeat(n.length - 4)}${n.slice(-2)}` : n ?? 'not recorded');
const TZ = 'Africa/Kampala';
const when = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const whenFull = (iso?: string | null) =>
  iso ? `${new Date(iso).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} EAT` : '';

/** A solid circle with a white tick or an exclamation mark: the mockup's status icon for confirmed and needs-attention lines. */
function StatusDot({ ok, size = 'md' }: { ok: boolean; size?: 'sm' | 'md' }) {
  const box = size === 'md' ? 'h-7 w-7' : 'h-5 w-5';
  return (
    <span className={`flex ${box} shrink-0 items-center justify-center rounded-full text-white ${ok ? 'bg-[#1A8A47]' : 'bg-[#D98A00]'}`} aria-hidden="true">
      {ok ? <Check className={size === 'md' ? 'h-4 w-4' : 'h-3 w-3'} strokeWidth={3.5} /> : <span className="text-sm font-black leading-none">!</span>}
    </span>
  );
}

const STATUS_CHIP: Record<NumberChangeRequest['status'], string> = {
  pending: 'bg-[#FFE49A] text-[#6B4200] dark:bg-amber-400/30 dark:text-amber-200',
  approved: 'bg-[#C9EFD5] text-[#0B6630] dark:bg-emerald-500/30 dark:text-emerald-200',
  rejected: 'bg-[#FFD6D6] text-[#B42318] dark:bg-red-500/30 dark:text-red-200',
  cancelled: 'bg-slate-200 text-slate-700 dark:bg-slate-600 dark:text-slate-100',
};

function ProviderChip({ provider }: { provider: string | null }) {
  const p = (provider ?? '').toLowerCase();
  const cls = p.includes('airtel') ? 'bg-[#FFD9DE] text-[#C4122F] dark:bg-red-500/30 dark:text-red-200' : p.includes('mtn') ? 'bg-[#FFE066] text-[#5C4400] dark:bg-yellow-400/30 dark:text-yellow-100' : 'bg-slate-200 text-slate-700';
  const logo = p.includes('airtel') ? airtelLogoAsset.url : p.includes('mtn') ? mtnLogoAsset.url : null;
  return (
    <span className={`inline-flex items-center gap-2 rounded-full py-1 pl-1.5 pr-4 text-sm font-extrabold ${cls}`}>
      {logo ? <img src={logo} alt="" className="h-6 w-6 rounded-full bg-white object-contain" loading="lazy" /> : null}
      {provider ? provider.replace(/^./, (c) => c.toUpperCase()) : 'Network'}
    </span>
  );
}

/** Withdrawable balance of the person, read-only. A denied or failed read simply hides the line. */
function useHeldBalance(userId: string) {
  return useQuery({
    queryKey: ['finops-number-change-balance', userId],
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.from('wallets').select('withdrawable_balance').eq('user_id', userId).maybeSingle();
      if (error) throw error;
      return Number((data as { withdrawable_balance?: number | string } | null)?.withdrawable_balance ?? 0);
    },
  });
}

function RequestDetail({ r, readOnly, earlier }: { r: NumberChangeRequest; readOnly: boolean; earlier: NumberChangeRequest[] }) {
  const decide = useDecideNumberChange();
  const vetting = useNumberChangeVetting(r.id, !readOnly);
  const balance = useHeldBalance(r.user_id);
  const [reason, setReason] = useState('');
  const [nameProof, setNameProof] = useState('');
  const [nameChecked, setNameChecked] = useState(false);
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);

  const idName = r.full_name ?? '';
  const proofReady = nameChecked && nameProof.trim().length >= 25;
  const looksSame = namesLookAlike(idName, r.requested_name);
  const approveLocked = !!busy || vetting.data?.approvable === false || !proofReady || reason.trim().length < 10;

  const act = async (decision: 'approved' | 'rejected') => {
    if (reason.trim().length < 10) {
      toast.error('Write at least 10 characters explaining the decision.');
      return;
    }
    if (decision === 'approved' && !proofReady) {
      toast.error('Confirm the number is registered in the names on the National ID, and write the proof statement (25 characters minimum).');
      return;
    }
    setBusy(decision);
    try {
      const note =
        decision === 'approved'
          ? `NAME CHECK on ${r.requested_number} (${(r.requested_provider ?? '').toUpperCase()}) — registered names match National ID ${r.national_id ?? 'not recorded'} (${idName || 'name not on file'}): ${nameProof.trim()} | Decision: ${reason.trim()}`
          : reason.trim();
      await decide.mutateAsync({ id: r.id, decision, reason: note });
      toast.success(decision === 'approved' ? 'Approved. Their withdrawal number now points to the new line.' : 'Rejected. Their withdrawal number stays as it was.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the decision.');
    } finally {
      setBusy(null);
    }
  };

  const v = vetting.data;

  return (
    <>
      {/* Middle: the request */}
      <section className="min-w-0 space-y-3 lg:px-5" aria-label="Request details">
        <div>
          <h3 className="text-xl font-bold text-foreground">{r.full_name ?? 'Unnamed account'}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><Phone className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> Phone: <span className="text-foreground">{r.phone ?? 'no phone'}</span></span>
            <span className="inline-flex items-center gap-1.5"><IdCard className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> National ID: <span className="font-mono text-foreground">{maskId(r.national_id)}</span></span>
            <span className="inline-flex items-center gap-1.5"><Calendar className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> Requested: <span className="text-foreground">{whenFull(r.created_at)}</span></span>
          </div>
        </div>

        <div className="rounded-xl border border-border">
          <div className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3">
            <dl className="space-y-1.5 text-sm">
              <div className="flex gap-6"><dt className="w-10 text-muted-foreground">From</dt><dd className="font-bold text-foreground">{r.current_number ?? 'none on file'}</dd></div>
              <div className="flex gap-6"><dt className="w-10 text-muted-foreground">To</dt><dd className="font-bold text-foreground">{r.requested_number}</dd></div>
            </dl>
            <ProviderChip provider={r.requested_provider} />
          </div>
          <dl className="space-y-1.5 border-t border-border/70 px-4 py-3 text-sm">
            <div className="flex gap-4"><dt className="w-24 shrink-0 text-muted-foreground">Name on it:</dt><dd className="font-bold text-foreground">{r.requested_name}</dd></div>
            <div className="flex gap-4"><dt className="w-24 shrink-0 text-muted-foreground">Their reason:</dt><dd className="text-foreground">{r.request_reason}</dd></div>
          </dl>
        </div>

        <p className={`flex items-center gap-2 text-sm font-semibold ${r.ownership_code_confirmed_at ? 'text-[#13803E] dark:text-emerald-300' : 'text-[#9A5B00] dark:text-amber-300'}`}>
          <StatusDot ok={!!r.ownership_code_confirmed_at} size="sm" />
          {r.ownership_code_confirmed_at ? 'New number confirmed by SMS code.' : 'The new number was not confirmed by code.'}
        </p>

        {!readOnly && (
          vetting.isLoading ? (
            <Skeleton className="h-16 w-full rounded-xl" />
          ) : v ? (
            <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${v.approvable ? 'border-[#86D19F] bg-[#D9F3E2] dark:border-emerald-500/50 dark:bg-emerald-500/20' : 'border-[#F0B53F] bg-[#FFEDB8] dark:border-amber-400/50 dark:bg-amber-400/20'}`}>
              <StatusDot ok={v.approvable} />
              <div className="min-w-0 text-sm">
                <p className="font-bold text-foreground">System check: {v.message}</p>
                {v.other_holder_name && <p className="text-foreground/80">Held by: {v.other_holder_name}</p>}
                {v.kind === 'name_or_provider_update' && <p className="text-foreground/80">Same number: they are correcting the registered name or provider.</p>}
                <p className="text-xs text-muted-foreground">Rechecked {vetting.dataUpdatedAt && Date.now() - vetting.dataUpdatedAt < 60_000 ? 'just now' : whenFull(new Date(vetting.dataUpdatedAt).toISOString())}</p>
              </div>
            </div>
          ) : null
        )}

        <div className="grid grid-cols-2 gap-2">
          <Button asChild variant="outline" className="min-h-[44px] rounded-xl font-semibold"><a href={`tel:${r.phone ?? ''}`}><Phone className="mr-2 h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> Call them</a></Button>
          <Button asChild variant="outline" className="min-h-[44px] rounded-xl font-semibold"><a href={`tel:${r.requested_number}`}><Phone className="mr-2 h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" /> Call new number</a></Button>
        </div>

        {balance.data != null && (
          <div className="flex items-center gap-2.5 rounded-xl border border-border px-4 py-3 text-sm font-semibold text-foreground">
            <Wallet className="h-[18px] w-[18px] text-slate-600" strokeWidth={1.75} aria-hidden="true" /> Held balance: {formatUGX(balance.data)}
          </div>
        )}

        <details className="group rounded-xl border border-border">
          <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2.5 px-4 text-sm font-bold text-foreground">
            <List className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
            <span className="flex-1">Earlier number changes ({earlier.length})</span>
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <ul className="divide-y divide-border/60 border-t border-border/70">
            {earlier.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">No earlier requests from this person.</li>}
            {earlier.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="font-semibold text-foreground">{e.current_number ?? 'none'} → {e.requested_number}</span>
                <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${STATUS_CHIP[e.status]}`}>{e.status}</span>
                <span className="text-xs text-muted-foreground">{when(e.decided_at ?? e.created_at)}</span>
              </li>
            ))}
          </ul>
        </details>
      </section>

      {/* Right: the check and the decision */}
      <section className="min-w-0 space-y-3 lg:pl-5" aria-label={readOnly ? 'Decision' : 'Required ownership check'}>
        {readOnly ? (
          <>
            <h3 className="text-lg font-bold text-foreground">Decision</h3>
            <div className="space-y-2 rounded-xl border border-border p-4 text-sm">
              <span className={`inline-flex rounded-md px-2.5 py-1 text-xs font-bold uppercase ${STATUS_CHIP[r.status]}`}>{r.status}</span>
              <p><span className="font-semibold">Reason: </span>{r.decision_reason ?? 'not stated'}</p>
              <p className="text-muted-foreground">{r.decided_by_name ?? 'unknown'} · {whenFull(r.decided_at)}</p>
            </div>
          </>
        ) : (
          <>
            <h3 className="text-lg font-bold text-foreground">Required ownership check</h3>
            <div className="grid gap-3 rounded-xl bg-[#EEECF4] p-3.5 dark:bg-slate-800 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="flex gap-3">
                <Info className="mt-0.5 h-6 w-6 shrink-0 text-slate-600" strokeWidth={1.75} aria-hidden="true" />
                <ol className="list-decimal space-y-1 pl-4 text-sm text-foreground">
                  <li>Open mobile money on your own phone.</li>
                  <li>Start <strong>Send Money</strong> to the new number.</li>
                  <li>Stop before confirming; read the name.</li>
                  <li>Compare with the <strong>National ID name</strong>.</li>
                </ol>
              </div>
              <p className="flex items-center gap-2 text-sm font-extrabold text-[#D92D20] sm:border-l sm:border-slate-300 sm:pl-4"><AlertCircle className="h-6 w-6 shrink-0" strokeWidth={2} aria-hidden="true" /> Do not send any money.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border px-3 py-2"><p className="text-xs text-muted-foreground">ID name</p><p className="text-sm font-bold text-foreground">{idName || 'not on file'}{r.national_id ? <span className="font-normal text-muted-foreground"> ({maskId(r.national_id)})</span> : null}</p></div>
              <div className="rounded-xl border border-border px-3 py-2"><p className="text-xs text-muted-foreground">Registered name</p><p className="text-sm font-bold text-foreground">{r.requested_name}</p></div>
            </div>
            <p className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${looksSame ? 'bg-[#EADFFF] text-[#5A1FD0] dark:bg-violet-500/30 dark:text-violet-100' : 'bg-[#FFEDB8] text-[#7A4B00] dark:bg-amber-400/20 dark:text-amber-200'}`}>
              <Info className="h-[18px] w-[18px] shrink-0" strokeWidth={2} aria-hidden="true" />
              {looksSame ? 'Names share a word · Manual check still required.' : 'These names do not match. Do not approve unless the number is genuinely in the ID names.'}
            </p>

            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={nameChecked} onChange={(e) => setNameChecked(e.target.checked)} />
              <span>I checked ••• {last3(r.requested_number)} on {(r.requested_provider ?? 'the network').replace(/^./, (c) => c.toUpperCase())} and it is registered in the names on this National ID.</span>
            </label>

            <div>
              <label htmlFor={`proof-${r.id}`} className="text-sm font-bold text-foreground">Proof of network name check</label>
              <Textarea id={`proof-${r.id}`} value={nameProof} onChange={(e) => setNameProof(e.target.value)} rows={2} placeholder="How you checked + exact name the network showed" className="mt-1" />
              <p className="mt-1 text-right text-xs text-muted-foreground">{nameProof.trim().length} / 25 minimum</p>
            </div>
            <div>
              <label htmlFor={`reason-${r.id}`} className="text-sm font-bold text-foreground">What did the call establish?</label>
              <Textarea id={`reason-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="At least 10 characters." className="mt-1" />
              <p className="mt-1 text-right text-xs text-muted-foreground">{reason.trim().length} / 10 minimum</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" className="min-h-[48px] rounded-xl border-[#E0352B] bg-white font-extrabold text-[#D92D20] hover:bg-[#FFECEB] dark:bg-transparent" disabled={!!busy || reason.trim().length < 10} onClick={() => act('rejected')}>
                {busy === 'rejected' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />} Reject
              </Button>
              <Button className="min-h-[48px] rounded-xl font-bold" disabled={approveLocked} onClick={() => act('approved')}>
                {busy === 'approved' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : approveLocked ? <Lock className="mr-2 h-4 w-4" /> : <CheckCircle2 className="mr-2 h-4 w-4" />} Approve change
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Approval requires ownership confirmation, proof and an allowed system check. Rejection requires a reason. A decision sends an SMS: approval updates the number; rejection keeps it.
            </p>
          </>
        )}
      </section>
    </>
  );
}

export default function PayoutNumberChangeQueue() {
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const queue = useNumberChangeQueue(tab);
  const allQueue = useNumberChangeQueue('all');
  const [selected, setSelected] = useState<string | null>(null);

  const rows = (queue.data ?? []).filter((r) => (tab === 'pending' ? r.status === 'pending' : r.status !== 'pending'));
  const waiting = (tab === 'pending' ? queue.data ?? [] : allQueue.data ?? []).filter((r) => r.status === 'pending').length;
  const current = rows.find((r) => r.id === selected) ?? rows[0] ?? null;
  const index = current ? rows.findIndex((r) => r.id === current.id) : -1;

  useEffect(() => { setSelected(null); }, [tab]);

  const earlier = current ? (allQueue.data ?? []).filter((e) => e.user_id === current.user_id && e.id !== current.id) : [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-3xl font-black tracking-tight text-foreground">Number change requests</h2>
        <p className="mt-1 text-sm text-muted-foreground">Review ownership before changing a payout number.</p>
      </div>

      <section className="rounded-2xl border-2 border-[#B79BF2] bg-card p-4 shadow-sm sm:p-5" aria-label="Withdrawal number changes">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Shield className="h-7 w-7 text-[#6D2EE8]" strokeWidth={1.75} aria-hidden="true" />
            <h3 className="text-xl font-bold text-foreground">Withdrawal number changes</h3>
            <span className="rounded-full bg-[#E6DAFF] px-3.5 py-1 text-xs font-extrabold text-[#5A1FD0] dark:bg-violet-500/30 dark:text-violet-100">{waiting} waiting</span>
          </div>
          <div role="tablist" aria-label="Which requests" className="inline-flex rounded-xl border border-border bg-muted/40 p-1">
            {([['pending', 'Waiting'], ['all', 'Decided']] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                className={`min-h-[36px] rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${tab === id ? 'bg-primary text-primary-foreground shadow-sm' : 'text-foreground hover:bg-muted'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {queue.isLoading ? (
          <Skeleton className="mt-4 h-72 w-full rounded-xl" />
        ) : !current ? (
          <div className="mt-4 rounded-xl border border-dashed border-border p-10 text-center">
            <ArrowUpDown className="mx-auto mb-2 h-8 w-8 text-[#6D2EE8]" aria-hidden="true" />
            <p className="text-sm font-semibold text-foreground">{tab === 'pending' ? 'No number change requests waiting' : 'No decided requests yet'}</p>
          </div>
        ) : (
          <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)_minmax(0,1fr)] lg:divide-x lg:divide-border">
            {/* Left: the list */}
            <section className="min-w-0 space-y-3 lg:pr-5" aria-label="Change requests">
              <h3 className="text-lg font-bold text-foreground">Change requests ({rows.length})</h3>
              <ul className="max-h-72 space-y-2.5 overflow-y-auto lg:max-h-[26rem]">
                {rows.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => setSelected(r.id)} aria-pressed={r.id === current.id}
                      className={`w-full rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${r.id === current.id ? 'border-2 border-[#7C3AED] bg-[#F1EAFF] shadow-sm dark:bg-violet-500/20' : 'border-border hover:border-[#B79BF2]'}`}>
                      <span className="flex items-start justify-between gap-2">
                        <span className="truncate text-base font-bold text-foreground">{r.full_name ?? 'Unnamed account'}</span>
                        <span className={`shrink-0 rounded-full px-3 py-0.5 text-xs font-extrabold capitalize ${STATUS_CHIP[r.status]}`}>{r.status}</span>
                      </span>
                      <span className="mt-1 block text-sm text-muted-foreground">{(r.requested_provider ?? '').replace(/^./, (c) => c.toUpperCase())} · ••• {last3(r.current_number)} → ••• {last3(r.requested_number)}</span>
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Calendar className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> Requested {when(r.created_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between gap-2 pt-1">
                <Button variant="outline" size="icon" className="h-10 w-10 rounded-lg" disabled={index <= 0} onClick={() => setSelected(rows[index - 1].id)} aria-label="Previous request"><ChevronLeft className="h-4 w-4" /></Button>
                <span className="text-sm text-foreground">Request {index + 1} of {rows.length}</span>
                <Button variant="outline" size="icon" className="h-10 w-10 rounded-lg" disabled={index >= rows.length - 1} onClick={() => setSelected(rows[index + 1].id)} aria-label="Next request"><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </section>

            <RequestDetail key={current.id} r={current} readOnly={current.status !== 'pending'} earlier={earlier} />
          </div>
        )}
      </section>
    </div>
  );
}
