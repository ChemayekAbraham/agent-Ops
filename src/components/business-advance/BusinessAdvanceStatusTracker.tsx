import { CheckCircle2, Clock, AlertTriangle, Circle, Briefcase, Banknote, XCircle, ArrowRight, PartyPopper, ListChecks, Phone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

export type AdvanceStatusRow = {
  id: string;
  status: string;
  business_name: string | null;
  principal: number | string;
  outstanding_balance?: number | string | null;
  reason?: string | null;
  agent_name?: string | null;
  created_at: string;
  agent_ops_reviewed_at?: string | null;
  tenant_ops_reviewed_at?: string | null;
  landlord_ops_reviewed_at?: string | null;
  coo_approved_at?: string | null;
  cfo_disbursed_at?: string | null;
  disbursed_at?: string | null;
  completed_at?: string | null;
  rejection_reason?: string | null;
};

type StageStatus = 'submitted' | 'reviewed' | 'approved' | 'rejected' | 'completed' | 'in_progress' | 'pending';

type Stage = {
  key: string;
  label: string;
  tsField: keyof AdvanceStatusRow;
  category: 'submitted' | 'reviewed' | 'approved' | 'completed';
  /** Description of what happens at this stage — surfaced on the "current" item. */
  description: string;
  /** Typical SLA estimate shown to the applicant. */
  eta: string;
  /** Concrete next-step instructions for the applicant while this stage is active. */
  applicantActions: string[];
  /** One-line headline summarising what to do right now. */
  actionHeadline: string;
};

const STAGES: Stage[] = [
  {
    key: 'submitted',
    label: 'Submitted',
    tsField: 'created_at',
    category: 'submitted',
    description: 'Your agent has filed the request and uploaded supporting details.',
    eta: 'Within minutes',
    actionHeadline: 'Keep your phone nearby',
    applicantActions: [
      'Keep your phone reachable — Agent Ops may call to confirm details.',
      'Have your National ID and a recent rent receipt ready.',
      'No action needed in the app yet — we will move this forward shortly.',
    ],
  },
  {
    key: 'agent_ops',
    label: 'Reviewed by Agent Ops',
    tsField: 'agent_ops_reviewed_at',
    category: 'reviewed',
    description: 'Agent Ops checks the request, your agent and supporting documents.',
    eta: 'Same day',
    actionHeadline: 'Document & agent check in progress',
    applicantActions: [
      'Agent Ops will verify the documents your agent uploaded.',
      'If anything is missing, your agent will contact you to re-capture it.',
      'No action needed yet — this is an internal check.',
    ],
  },
  {
    key: 'tenant_ops',
    label: 'Reviewed by Tenant Ops',
    tsField: 'tenant_ops_reviewed_at',
    category: 'reviewed',
    description: 'Tenant Ops verifies your identity, ID, rent history and contacts.',
    eta: 'Same day',
    actionHeadline: 'Identity & rent history check',
    applicantActions: [
      'Answer any call from a Welile (+256) number — we may verify your details.',
      'Make sure your National ID number on file matches your physical ID.',
      'If your phone changed recently, ask your agent to update it.',
    ],
  },
  {
    key: 'landlord_ops',
    label: 'Reviewed by Landlord Ops',
    tsField: 'landlord_ops_reviewed_at',
    category: 'reviewed',
    description: 'We verify your rent payment history with your landlord(s).',
    eta: '1–2 days',
    actionHeadline: 'Landlord verification',
    applicantActions: [
      'Let your landlord know Welile may call to confirm your tenancy.',
      'Share your landlord\'s correct phone number with your agent if it has changed.',
      'No app action needed — we will reach out to them directly.',
    ],
  },
  {
    key: 'coo',
    label: 'Approved by COO',
    tsField: 'coo_approved_at',
    category: 'approved',
    description: 'Final operational approval before disbursement.',
    eta: '1 day',
    actionHeadline: 'Final sign-off in progress',
    applicantActions: [
      'All checks passed — awaiting final COO approval.',
      'No action required from you.',
      'You will get an SMS and email the moment funds are released.',
    ],
  },
  {
    key: 'disbursed',
    label: 'Disbursed to your wallet',
    tsField: 'disbursed_at',
    category: 'completed',
    description: 'Funds land in your Welile wallet, ready to use.',
    eta: 'Within hours of COO approval',
    actionHeadline: 'Funds being released',
    applicantActions: [
      'CFO is releasing your funds into your Welile wallet now.',
      'Open your wallet to confirm the balance once you receive the SMS.',
      'Repayments start as agreed with your agent — track them here any time.',
    ],
  },
  {
    key: 'completed',
    label: 'Fully repaid',
    tsField: 'completed_at',
    category: 'completed',
    description: 'The advance has been paid off in full — your trust score grows.',
    eta: 'Based on your repayment pace',
    actionHeadline: 'You are paid in full',
    applicantActions: [
      'Your trust score just grew — you qualify for a higher next limit.',
      'Ask your agent about your new ceiling whenever you are ready.',
    ],
  },
];

const STAGE_BADGE: Record<StageStatus, { label: string; cls: string }> = {
  submitted:  { label: 'Submitted',   cls: 'bg-sky-500/10 text-sky-700 border-sky-500/30' },
  reviewed:   { label: 'Reviewed',    cls: 'bg-blue-500/10 text-blue-700 border-blue-500/30' },
  approved:   { label: 'Approved',    cls: 'bg-violet-500/10 text-violet-700 border-violet-500/30' },
  completed:  { label: 'Completed',   cls: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30' },
  rejected:   { label: 'Rejected',    cls: 'bg-red-500/10 text-red-700 border-red-500/30' },
  in_progress:{ label: 'In progress', cls: 'bg-amber-500/10 text-amber-700 border-amber-500/30' },
  pending:    { label: 'Pending',     cls: 'bg-muted text-muted-foreground border-muted' },
};

function deriveOverall(row: AdvanceStatusRow): StageStatus {
  if (row.status === 'rejected' || row.status === 'defaulted') return 'rejected';
  if (row.status === 'completed') return 'completed';
  if (row.disbursed_at || row.status === 'active') return 'approved';
  if (row.coo_approved_at) return 'approved';
  if (row.agent_ops_reviewed_at || row.tenant_ops_reviewed_at || row.landlord_ops_reviewed_at) return 'reviewed';
  return 'submitted';
}

export function BusinessAdvanceStatusTracker({ row, compact = false }: { row: AdvanceStatusRow; compact?: boolean }) {
  const rejected = row.status === 'rejected' || row.status === 'defaulted';

  // Per-stage state — done / current / pending / blocked
  let firstPendingMarked = false;
  const states = STAGES.map((s) => {
    if (rejected) return s.tsField === 'created_at' ? 'done' as const : 'blocked' as const;
    if (row[s.tsField]) return 'done' as const;
    if (!firstPendingMarked) { firstPendingMarked = true; return 'current' as const; }
    return 'pending' as const;
  });

  const overall = deriveOverall(row);
  const overallBadge = rejected ? STAGE_BADGE.rejected : STAGE_BADGE[overall];
  const currentStageIdx = states.indexOf('current');
  const currentStage = currentStageIdx >= 0 ? STAGES[currentStageIdx] : null;

  const createdAgo = formatDistanceToNowStrict(new Date(row.created_at), { addSuffix: true });

  const ackKey = currentStage ? `ba-ack:${row.id}:${currentStage.key}` : null;
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    if (!ackKey) { setAcknowledged(false); return; }
    try { setAcknowledged(localStorage.getItem(ackKey) != null); } catch { setAcknowledged(false); }
  }, [ackKey]);

  const handleAcknowledge = () => {
    if (!ackKey || !currentStage) return;
    try { localStorage.setItem(ackKey, new Date().toISOString()); } catch {}
    setAcknowledged(true);
    toast.success('Thanks for confirming', {
      description: `We've noted that you've reviewed the next steps for "${currentStage.label}".`,
    });
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-primary shrink-0" />
            <p className="font-bold text-sm truncate">{row.business_name || 'Business Advance'}</p>
          </div>
          {row.agent_name && (
            <p className="text-[11px] text-muted-foreground mt-0.5">Requested by agent: {row.agent_name}</p>
          )}
          <p className="text-[10px] text-muted-foreground mt-0.5">Submitted {createdAgo}</p>
        </div>
        <div className="text-right shrink-0 space-y-1">
          <Badge variant="outline" className={`${overallBadge.cls} text-[10px] uppercase tracking-wider font-bold`}>
            {overallBadge.label}
          </Badge>
          <p className="font-bold text-sm">{formatUGX(Number(row.principal) || 0)}</p>
        </div>
      </div>

      {/* Rejection callout */}
      {rejected && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 flex gap-2 text-xs text-destructive">
          <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold uppercase tracking-wide text-[10px] mb-0.5">Rejected</p>
            <p>{row.rejection_reason || 'This request did not pass review. Please speak with your agent for next steps.'}</p>
          </div>
        </div>
      )}

      {/* "What's happening next" hint — only while in-flight */}
      {!rejected && currentStage && row.status !== 'completed' && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-900">
          <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-[10px] text-amber-700 mb-1">
            <ArrowRight className="h-3 w-3" /> What's next
          </div>
          <p className="font-semibold">{currentStage.label}</p>
          <p className="text-[11px] mt-0.5 text-amber-800/90">{currentStage.description}</p>
          <p className="text-[10px] mt-1 text-amber-700/80">Typical wait: {currentStage.eta}</p>

          {/* Concrete next-step instructions for the applicant */}
          <div className="mt-2 pt-2 border-t border-amber-500/30">
            <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-[10px] text-amber-700 mb-1">
              <ListChecks className="h-3 w-3" /> What you should do now
            </div>
            <p className="text-[11px] font-semibold text-amber-900">{currentStage.actionHeadline}</p>
            <ul className="mt-1 space-y-1">
              {currentStage.applicantActions.map((a, idx) => (
                <li key={idx} className="text-[11px] text-amber-900/90 flex gap-1.5 items-start leading-snug">
                  <span className="text-amber-700 mt-[2px]">•</span>
                  <span>{a}</span>
                </li>
              ))}
            </ul>
            <p className="text-[10px] mt-2 text-amber-700/80 flex items-center gap-1">
              <Phone className="h-3 w-3" /> Calls from any +256 number starting with Welile are genuine.
            </p>

            <div className="mt-2.5 pt-2 border-t border-amber-500/30">
              {acknowledged ? (
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  You've confirmed these next steps. We'll notify you as soon as this stage moves.
                </div>
              ) : (
                <Button
                  size="sm"
                  onClick={handleAcknowledge}
                  className="h-8 w-full bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                  Confirm I've done this
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Completed celebration */}
      {!rejected && row.status === 'completed' && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 flex gap-2 text-xs text-emerald-800">
          <PartyPopper className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>Your Business Advance is fully repaid — well done!</span>
        </div>
      )}

      {/* Timeline */}
      <ol className="space-y-2">
        {STAGES.map((stage, i) => {
          const st = states[i];
          // Skip the trailing "completed" milestone unless we've actually started repaying
          if (stage.key === 'completed' && !row.completed_at && row.status !== 'active') return null;

          const Icon =
            st === 'done' ? CheckCircle2 :
            st === 'current' ? Clock :
            st === 'blocked' ? XCircle : Circle;
          const color =
            st === 'done' ? 'text-emerald-600' :
            st === 'current' ? 'text-amber-600 animate-pulse' :
            st === 'blocked' ? 'text-destructive' : 'text-muted-foreground/50';
          const lineColor = st === 'done' ? 'bg-emerald-500/60' : 'bg-muted';

          const stageBadge: StageStatus =
            st === 'blocked' ? 'rejected' :
            st === 'done' ? stage.category :
            st === 'current' ? 'in_progress' : 'pending';
          const badge = STAGE_BADGE[stageBadge];

          const ts = row[stage.tsField];

          return (
            <li key={stage.key} className="flex gap-3 items-start">
              <div className="flex flex-col items-center pt-0.5">
                <Icon className={`h-4 w-4 ${color}`} />
                {i < STAGES.length - 1 && <div className={`w-px flex-1 min-h-[14px] mt-1 ${lineColor}`} />}
              </div>
              <div className="flex-1 -mt-0.5 pb-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className={`text-xs font-semibold ${
                    st === 'done' || st === 'current' ? 'text-foreground' : 'text-muted-foreground'
                  }`}>
                    {stage.label}
                  </p>
                  <Badge variant="outline" className={`${badge.cls} text-[9px] uppercase tracking-wider font-bold h-4 px-1.5`}>
                    {badge.label}
                  </Badge>
                </div>
                {ts ? (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {format(new Date(ts as string), 'MMM d, yyyy • HH:mm')}
                  </p>
                ) : st === 'current' ? (
                  <p className="text-[10px] text-amber-700 mt-0.5">ETA: {stage.eta}</p>
                ) : st === 'pending' ? (
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">Waiting for previous step</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {(row.status === 'active' || row.status === 'completed') && row.outstanding_balance != null && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 text-xs flex items-center gap-2">
          <Banknote className="h-4 w-4 text-emerald-700" />
          <span className="text-emerald-800">
            {row.status === 'completed'
              ? 'Fully repaid — well done!'
              : <>Outstanding balance: <strong>{formatUGX(Number(row.outstanding_balance) || 0)}</strong></>}
          </span>
        </div>
      )}

      {!compact && row.reason && (
        <p className="text-[11px] text-muted-foreground italic">"{row.reason}"</p>
      )}
    </div>
  );
}

export default BusinessAdvanceStatusTracker;

/**
 * Derive the active stage (key + label) for a given advance row so external
 * components (e.g. the document-upload panel) can scope themselves to whichever
 * stage the request is currently sitting at. Returns null when the request is
 * rejected, completed, or fully past the timeline.
 */
export function getActiveAdvanceStage(row: AdvanceStatusRow): { key: string; label: string } | null {
  if (row.status === 'rejected' || row.status === 'defaulted' || row.status === 'completed') return null;
  for (const s of STAGES) {
    if (!row[s.tsField]) return { key: s.key, label: s.label };
  }
  return null;
}
