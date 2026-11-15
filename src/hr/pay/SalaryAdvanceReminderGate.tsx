import { useLocation, useNavigate } from 'react-router-dom';
import { HandCoins } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ApprovalReminderDialog } from '@/components/requisitions/ApprovalReminderDialog';
import { useApprovalReminder } from '@/components/requisitions/useApprovalReminder';

/**
 * Salary advance reminder (CFO 15 Nov 2026) — for whoever holds the advance's next step, decided by
 * `hr_pay_advance_pending_prompt()` (HR approval, CEO approval, or Pay to wallet; never one's own advance).
 * "Open advances" goes to the Salary Advances page, where the step is taken; "Later" puts it off for 4 hours on the
 * server. It takes no decision and moves no money. FAIL OPEN.
 */

export const SALARY_ADVANCES_PATH = '/hr/pay/advances';

interface Prompt {
  advance_id: string;
  status: string;
  step: 'hr' | 'ceo' | 'cfo';
  staff_name: string;
  staff_ref: string | null;
  principal: number;
  purpose: string;
  requested_at: string;
  snooze_count: number;
  total_pending: number;
}

const HEADINGS: Record<Prompt['step'], string> = {
  hr: 'Salary advance needs HR approval',
  ceo: 'Salary advance needs CEO approval',
  cfo: 'Salary advance approved — waiting to be paid',
};

function fmtDay(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

async function fetchPrompt(): Promise<Prompt | null> {
  const { data, error } = await supabase.rpc('hr_pay_advance_pending_prompt' as never);
  if (error) return null;
  const raw = data as unknown;
  return ((Array.isArray(raw) ? raw[0] : raw) as Prompt | undefined) ?? null;
}

async function snooze(p: Prompt): Promise<unknown> {
  const { data, error } = await supabase.rpc('hr_pay_advance_prompt_snooze' as never, { p_advance_id: p.advance_id } as never);
  if (error) throw error;
  return data;
}

export function SalaryAdvanceReminderGate() {
  const navigate = useNavigate();
  const location = useLocation();
  const { prompt, working, later } = useApprovalReminder({ fetchPrompt, snooze });
  if (!prompt || location.pathname === SALARY_ADVANCES_PATH) return null;

  return (
    <ApprovalReminderDialog
      icon={<HandCoins className="h-5 w-5 text-primary" />}
      title={HEADINGS[prompt.step] ?? 'Salary advance needs your action'}
      description={<>{prompt.staff_name}{prompt.staff_ref ? ` • ${prompt.staff_ref}` : ''} • requested {fmtDay(prompt.requested_at)}</>}
      snoozeCount={Number(prompt.snooze_count) || 0}
      openLabel="Open advances"
      working={working}
      onOpen={() => { void later().then((ok) => { if (ok) navigate(SALARY_ADVANCES_PATH); }); }}
      onLater={() => { void later(); }}
    >
      {Number(prompt.total_pending) > 1 && (
        <p className="text-xs font-medium text-muted-foreground">1 of {Number(prompt.total_pending)} waiting on you</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">Salary advance</p>
        <p className="text-lg font-bold text-primary">{formatUGX(Number(prompt.principal))}</p>
      </div>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{prompt.purpose}</p>
    </ApprovalReminderDialog>
  );
}

export default SalaryAdvanceReminderGate;
