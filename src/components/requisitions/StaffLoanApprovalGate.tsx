import { useNavigate } from 'react-router-dom';
import { Landmark } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ApprovalReminderDialog } from './ApprovalReminderDialog';
import { STAFF_APPROVALS_PATH } from './reminderTiming';
import { useApprovalReminder } from './useApprovalReminder';

/**
 * Staff loan reminder — for the named approver only (`staff_loan_pending_prompt()` decides who).
 *
 * A reminder, not a decision screen (CFO 15 Nov 2026): it shows what is waiting and offers "Open requisitions" (the
 * approvals queue, where the loan is approved, declined or paid) and "Later". Both put it off for 4 hours on the
 * server. FAIL OPEN: any error leaves the app usable.
 */

interface Prompt {
  prompt_id: string;
  kind: 'hr' | 'ceo' | 'cfo';
  requisition_id: string;
  requisition_code: string;
  borrower_name: string;
  amount: number;
  months: number;
  reason: string;
  snooze_count: number;
  submitted_at: string;
}

const HEADINGS: Record<Prompt['kind'], string> = {
  hr: 'Loan request needs your approval',
  ceo: 'Loan request needs final approval',
  cfo: 'Loan approved — waiting to be paid',
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

async function fetchPrompt(): Promise<Prompt | null> {
  const { data, error } = await supabase.rpc('staff_loan_pending_prompt' as never);
  if (error) return null;
  const raw = data as unknown;
  return ((Array.isArray(raw) ? raw[0] : raw) as Prompt | undefined) ?? null;
}

async function snooze(p: Prompt): Promise<unknown> {
  const { data, error } = await supabase.rpc('staff_loan_prompt_snooze' as never, { _prompt_id: p.prompt_id } as never);
  if (error) throw error;
  return (data as { snooze_until?: string } | null)?.snooze_until;
}

export function StaffLoanApprovalGate() {
  const navigate = useNavigate();
  const { prompt, working, later } = useApprovalReminder({ fetchPrompt, snooze });
  if (!prompt) return null;
  const months = Number(prompt.months);

  return (
    <ApprovalReminderDialog
      icon={<Landmark className="h-5 w-5 text-primary" />}
      title={HEADINGS[prompt.kind]}
      description={<>{prompt.borrower_name} • {prompt.requisition_code} • submitted {fmtDate(prompt.submitted_at)}</>}
      snoozeCount={Number(prompt.snooze_count) || 0}
      openLabel="Open requisitions"
      working={working}
      onOpen={() => { void later().then((ok) => { if (ok) navigate(STAFF_APPROVALS_PATH); }); }}
      onLater={() => { void later(); }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{months} {months === 1 ? 'month' : 'months'}</p>
        <p className="text-lg font-bold text-primary">{formatUGX(Number(prompt.amount))}</p>
      </div>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{prompt.reason}</p>
    </ApprovalReminderDialog>
  );
}

export default StaffLoanApprovalGate;
