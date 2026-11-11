import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Download, FileText, Loader2, Printer, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import {
  fetchFunderVerifiedPlan,
  filledTenantAgreement,
  agreementSummary,
  isMissingDossierError,
  type FunderFundingStep,
  type FunderVerifiedPlan,
} from '@/lib/funderVerifiedPlan';
import {
  downloadFunderRentPlanPdf,
  downloadFunderRentReceiptPdf,
  printFunderRentPlan,
  printFunderRentReceipt,
} from '@/lib/funderVerifiedPlanPdf';

function StepMark({ state }: { state: FunderFundingStep['state'] }) {
  return (
    <span
      className={cn(
        'mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full text-[11px] font-bold',
        state === 'done' && 'bg-emerald-600 text-white',
        state === 'current' && 'bg-primary text-primary-foreground',
        state === 'waiting' && 'bg-muted text-muted-foreground',
      )}
      aria-hidden
    >
      {state === 'done' ? <Check className="h-3.5 w-3.5" /> : state === 'current' ? <Smartphone className="h-3.5 w-3.5" /> : null}
    </span>
  );
}

function Timeline({ steps }: { steps: FunderFundingStep[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((step) => (
        <li key={step.key} className="flex gap-3">
          <StepMark state={step.state} />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{step.title}</p>
            <p className="text-xs leading-snug text-muted-foreground">{step.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

const COVER_STATUS_COPY: Record<string, string> = {
  awaiting_confirmation: 'Welile Cover is waiting for Welile to confirm this payment.',
  awaiting_topup: 'Welile Cover is waiting for a wallet top-up. Your balance was not charged.',
  charged: 'Welile Cover was charged from your Welile wallet.',
  waived: 'Welile Cover was not charged.',
  kept: 'Welile Cover stays with you. There is no proxy agent to pay.',
};

interface CoverRow {
  id: string;
  cover_fee_amount: number | null;
  cover_fee_status: string | null;
}

function coverStatusCopy(status: string | null | undefined): string | null {
  if (!status || status === 'none') return null;
  return COVER_STATUS_COPY[status] ?? null;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-sm font-semibold break-words">{value}</span>
    </div>
  );
}

/**
 * Verified contact details, the funding timeline, and the rent receipt.
 * The server decides what may be shown. This component only prints that reply.
 */
export function OffplatformCoverStatus({ rentRequestId }: { rentRequestId: string }) {
  const coverQuery = useQuery({
    queryKey: ['funder-offplatform-cover', rentRequestId],
    queryFn: async (): Promise<CoverRow[]> => {
      const { data, error } = await supabase
        .from('funder_offplatform_rent_payments' as never)
        .select('id, cover_fee_amount, cover_fee_status' as never)
        .eq('rent_request_id' as never, rentRequestId as never);
      if (error) {
        if (isMissingDossierError(error)) return [];
        throw error;
      }
      return (data as CoverRow[] | null) ?? [];
    },
    staleTime: 30_000,
    retry: false,
  });
  const lines = (coverQuery.data ?? [])
    .map((row) => ({ id: row.id, text: coverStatusCopy(row.cover_fee_status) }))
    .filter((row): row is { id: string; text: string } => Boolean(row.text));
  if (lines.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {lines.map((row) => (
        <p key={row.id} className="text-xs leading-snug text-muted-foreground">{row.text}</p>
      ))}
    </div>
  );
}

export function chargedCoverTotal(rows: CoverRow[] | undefined): number {
  return (rows ?? [])
    .filter((row) => row.cover_fee_status === 'charged')
    .reduce((sum, row) => sum + Number(row.cover_fee_amount || 0), 0);
}

export function FunderVerifiedPlanPack({ rentRequestId }: { rentRequestId: string }) {
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [busy, setBusy] = useState<'plan' | 'receipt' | 'print-plan' | 'print-receipt' | null>(null);
  const query = useQuery({
    queryKey: ['funder-verified-plan', rentRequestId],
    queryFn: () => fetchFunderVerifiedPlan(rentRequestId),
    staleTime: 60_000,
    retry: false,
  });
  const coverQuery = useQuery({
    queryKey: ['funder-offplatform-cover', rentRequestId],
    queryFn: async (): Promise<CoverRow[]> => {
      const { data, error } = await supabase
        .from('funder_offplatform_rent_payments' as never)
        .select('id, cover_fee_amount, cover_fee_status' as never)
        .eq('rent_request_id' as never, rentRequestId as never);
      if (error) {
        if (isMissingDossierError(error)) return [];
        throw error;
      }
      return (data as CoverRow[] | null) ?? [];
    },
    staleTime: 30_000,
    retry: false,
  });
  const chargedCover = chargedCoverTotal(coverQuery.data);

  const run = async (kind: NonNullable<typeof busy>, plan: FunderVerifiedPlan) => {
    setBusy(kind);
    try {
      if (kind === 'plan') await downloadFunderRentPlanPdf(plan);
      else if (kind === 'receipt') await downloadFunderRentReceiptPdf(plan, chargedCover);
      else if (kind === 'print-plan' && !printFunderRentPlan(plan)) toast.error('Allow pop-ups to print, or use Download PDF.');
      else if (kind === 'print-receipt' && !printFunderRentReceipt(plan, chargedCover)) toast.error('Allow pop-ups to print, or use Download PDF.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not prepare the document.');
    } finally {
      setBusy(null);
    }
  };

  if (query.isLoading) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-2xl border border-border/60 px-3 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading this Rent Plan
      </div>
    );
  }

  const result = query.data;
  if (!result || result.state === 'error') {
    return (
      <p className="mt-4 text-xs text-muted-foreground">Could not load this Rent Plan&apos;s funding status.</p>
    );
  }
  if (result.state === 'unavailable') {
    return (
      <p className="mt-4 text-xs text-muted-foreground">Verified Rent Plan details are not available yet.</p>
    );
  }
  if (result.state === 'hidden') {
    return (
      <p className="mt-4 text-xs text-muted-foreground">
        {result.code === 'not_verified'
          ? 'Landlord number, mobile money and the tenant agreement stay hidden until this Rent Plan is verified.'
          : 'These details are only shown for a verified Rent Plan you fund.'}
      </p>
    );
  }

  const plan = result.plan;
  const funding = plan.funding;

  return (
    <section className="mt-4 space-y-3">
      {funding && funding.steps.length > 0 && (
        <div className="rounded-2xl border border-border/60 bg-card p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Funding status</p>
          <div className="mt-3">
            <Timeline steps={funding.steps} />
          </div>
          <OffplatformCoverStatus rentRequestId={rentRequestId} />
        </div>
      )}

      {plan.verified && (
        <div className="rounded-2xl border border-border/60 bg-card px-4 py-1">
          <p className="pt-3 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Verified Rent Plan</p>
          <Fact label="Landlord" value={plan.landlordName} />
          <Fact label="Landlord phone" value={plan.landlordPhone || 'Not recorded'} />
          <Fact label="Mobile money number" value={plan.payoutMomoNumber || 'Not recorded'} />
          <Fact label="Name on the account" value={plan.payoutMomoName || 'Not recorded'} />
          <Fact label="Rent amount" value={formatUGX(plan.rentAmount)} />
          <Fact label="Repaid so far" value={plan.totalRepayment > 0 ? `${formatUGX(plan.amountRepaid)} of ${formatUGX(plan.totalRepayment)}` : formatUGX(plan.amountRepaid)} />
          <div className="py-3">
            <p className="text-xs text-muted-foreground">Tenant Partnership Agreement</p>
            <p className="text-sm font-semibold">{agreementSummary(plan)}</p>
            <Button type="button" variant="outline" className="mt-2 h-11 w-full rounded-xl" onClick={() => setAgreementOpen(true)}>
              <FileText className="h-4 w-4" />
              View agreement
            </Button>
          </div>
        </div>
      )}

      {!plan.verified && (
        <p className="text-xs text-muted-foreground">
          Landlord number, mobile money and the tenant agreement stay hidden until this Rent Plan is verified.
        </p>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {funding && (
          <>
            <Button type="button" className="h-11 rounded-xl" disabled={busy !== null} onClick={() => void run('receipt', plan)}>
              {busy === 'receipt' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download receipt
            </Button>
            <Button type="button" variant="outline" className="h-11 rounded-xl" disabled={busy !== null} onClick={() => void run('print-receipt', plan)}>
              <Printer className="h-4 w-4" />
              Print receipt
            </Button>
          </>
        )}
        {plan.verified && (
          <>
            <Button type="button" variant="outline" className="h-11 rounded-xl" disabled={busy !== null} onClick={() => void run('plan', plan)}>
              {busy === 'plan' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download PDF
            </Button>
            <Button type="button" variant="outline" className="h-11 rounded-xl" disabled={busy !== null} onClick={() => void run('print-plan', plan)}>
              <Printer className="h-4 w-4" />
              Print
            </Button>
          </>
        )}
      </div>

      <Dialog open={agreementOpen} onOpenChange={setAgreementOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Tenant Partnership Agreement</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{agreementSummary(plan)}</p>
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{filledTenantAgreement(plan)}</pre>
        </DialogContent>
      </Dialog>
    </section>
  );
}
