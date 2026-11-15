import { useNavigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ApprovalReminderDialog } from './ApprovalReminderDialog';
import { STAFF_APPROVALS_PATH } from './reminderTiming';
import { useApprovalReminder } from './useApprovalReminder';

/**
 * Facilitation reminder — for the named approver only (`pso_facilitation_pending_prompt()` decides who).
 *
 * A reminder, not a decision screen (CFO 15 Nov 2026): "Open requisitions" (the approvals queue, where it is
 * approved, declined or paid) and "Later", both putting it off for 4 hours on the server. FAIL OPEN.
 */

interface Prompt {
  prompt_id: string;
  requisition_id: string;
  requisition_code: string;
  officer_name: string;
  title: string;
  reason: string;
  amount: number;
  snooze_count: number;
  submitted_at: string;
  kind?: 'approval' | 'disbursement' | null;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

async function fetchPrompt(): Promise<Prompt | null> {
  const { data, error } = await supabase.rpc('pso_facilitation_pending_prompt');
  if (error) return null;
  return ((Array.isArray(data) ? data[0] : data) as unknown as Prompt | undefined) ?? null;
}

async function snooze(p: Prompt): Promise<unknown> {
  const { data, error } = await supabase.rpc('pso_facilitation_prompt_snooze', { _prompt_id: p.prompt_id });
  if (error) throw error;
  return (data as unknown as { snooze_until?: string } | null)?.snooze_until;
}

export function FacilitationApprovalGate() {
  const navigate = useNavigate();
  const { prompt, working, later } = useApprovalReminder({ fetchPrompt, snooze });
  if (!prompt) return null;

  return (
    <ApprovalReminderDialog
      icon={<ShieldAlert className="h-5 w-5 text-primary" />}
      title={prompt.kind === 'disbursement' ? 'Facilitation approved — waiting to be paid' : 'Facilitation needs your decision'}
      description={<>{prompt.officer_name} • {prompt.requisition_code} • submitted {fmtDate(prompt.submitted_at)}</>}
      snoozeCount={Number(prompt.snooze_count) || 0}
      openLabel="Open requisitions"
      working={working}
      onOpen={() => { void later().then((ok) => { if (ok) navigate(STAFF_APPROVALS_PATH); }); }}
      onLater={() => { void later(); }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{prompt.title}</p>
        <p className="text-lg font-bold text-primary">{formatUGX(Number(prompt.amount))}</p>
      </div>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{prompt.reason}</p>
    </ApprovalReminderDialog>
  );
}

export default FacilitationApprovalGate;
