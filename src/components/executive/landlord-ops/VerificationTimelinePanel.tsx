import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  ShieldCheck,
  Banknote,
  Hash,
  Clock,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface TimelineRow {
  id: string;
  listing_id: string;
  agent_id: string;
  amount: number;
  status: string;
  landlord_ops_approved_at: string | null;
  cfo_approved_at: string | null;
  paid_at: string | null;
  rejection_reason: string | null;
  ledger_entry_id: string | null; // populated with tx_group_id by credit-listing-bonus
  created_at: string;
  // joined
  listing_title?: string;
  agent_name?: string;
  // fallback (legacy rows that predate ledger_entry_id storage)
  audit_tx_group_id?: string | null;
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  paid: { label: '✅ Auto-Paid', className: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30' },
  pending_credit: { label: '⏳ Pending Credit', className: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
  pending_cfo: { label: '⏳ Pending CFO', className: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
  pending_landlord_ops: { label: '⏳ Pending Landlord Ops', className: 'bg-amber-500/15 text-amber-700 border-amber-500/30' },
  approved: { label: '✓ Approved', className: 'bg-blue-500/15 text-blue-700 border-blue-500/30' },
  failed: { label: '⚠️ Failed (rolled back)', className: 'bg-red-500/15 text-red-700 border-red-500/30' },
  rejected: { label: '❌ Rejected', className: 'bg-red-500/15 text-red-700 border-red-500/30' },
};

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-UG', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function durationBetween(a: string | null, b: string | null): string | null {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (ms < 0) return null;
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function CopyableId({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  const onCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast({ title: 'Copied', description: `${label} copied to clipboard` });
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={onCopy}
      className="inline-flex items-center gap-1 font-mono text-[10px] bg-muted/60 hover:bg-muted px-1.5 py-0.5 rounded transition-colors min-h-[24px]"
      title={`Click to copy ${label}`}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
      <span className="truncate max-w-[140px]">{value}</span>
    </button>
  );
}

function TimelineRow({ row }: { row: TimelineRow }) {
  const status = STATUS_LABELS[row.status] || {
    label: row.status,
    className: 'bg-muted text-muted-foreground border-border',
  };
  const txGroupId = row.ledger_entry_id || row.audit_tx_group_id || null;
  const verifyToPay = durationBetween(row.landlord_ops_approved_at, row.paid_at);

  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">{row.listing_title || 'Unknown listing'}</p>
          <p className="text-[11px] text-muted-foreground">
            Agent: <span className="text-foreground font-medium">{row.agent_name || 'Unknown'}</span>
            <span className="mx-1.5">·</span>
            <span className="font-bold text-primary">UGX {Number(row.amount).toLocaleString()}</span>
          </p>
        </div>
        <Badge className={`shrink-0 text-[10px] border ${status.className}`}>{status.label}</Badge>
      </div>

      {/* Timeline steps */}
      <ol className="relative border-l border-border pl-4 ml-1.5 space-y-2">
        <li className="relative">
          <span className="absolute -left-[19px] top-1 inline-flex h-3 w-3 rounded-full bg-blue-500/20 border-2 border-blue-500" />
          <div className="flex items-center gap-1.5 text-[11px] font-medium">
            <ShieldCheck className="h-3 w-3 text-blue-600" />
            Landlord Ops verified
          </div>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
            <Clock className="h-2.5 w-2.5" /> {formatDateTime(row.landlord_ops_approved_at)}
          </p>
        </li>

        {row.status === 'paid' && (
          <li className="relative">
            <span className="absolute -left-[19px] top-1 inline-flex h-3 w-3 rounded-full bg-emerald-500/20 border-2 border-emerald-500" />
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              <Banknote className="h-3 w-3 text-emerald-600" />
              Auto-paid to agent wallet
            </div>
            <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
              <Clock className="h-2.5 w-2.5" /> {formatDateTime(row.paid_at)}
              {verifyToPay && (
                <span className="ml-1 text-emerald-700">({verifyToPay} after verify)</span>
              )}
            </p>
          </li>
        )}

        {row.status === 'failed' && (
          <li className="relative">
            <span className="absolute -left-[19px] top-1 inline-flex h-3 w-3 rounded-full bg-red-500/20 border-2 border-red-500" />
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-red-700">
              <AlertTriangle className="h-3 w-3" />
              Ledger write failed — rolled back
            </div>
            {row.rejection_reason && (
              <p className="text-[10px] text-red-600 mt-0.5 italic">"{row.rejection_reason}"</p>
            )}
          </li>
        )}

        {row.status === 'pending_credit' && (
          <li className="relative">
            <span className="absolute -left-[19px] top-1 inline-flex h-3 w-3 rounded-full bg-amber-500/20 border-2 border-amber-500" />
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700">
              <Loader2 className="h-3 w-3 animate-spin" />
              Credit in flight…
            </div>
          </li>
        )}
      </ol>

      {/* IDs */}
      <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/50">
        <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
          <Hash className="h-2.5 w-2.5" /> Approval
        </span>
        <CopyableId value={row.id} label="Approval ID" />

        {txGroupId && (
          <>
            <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1 ml-1">
              <Hash className="h-2.5 w-2.5" /> Tx Group
            </span>
            <CopyableId value={txGroupId} label="Ledger transaction group ID" />
          </>
        )}
      </div>
    </div>
  );
}

export function VerificationTimelinePanel() {
  const [expanded, setExpanded] = useState(false);
  const LIMIT_COLLAPSED = 0;

  const { data: rows, isLoading } = useQuery<TimelineRow[]>({
    queryKey: ['landlord-ops-verification-timeline'],
    queryFn: async () => {
      const { data: approvals } = await supabase
        .from('listing_bonus_approvals')
        .select(
          'id, listing_id, agent_id, amount, status, landlord_ops_approved_at, cfo_approved_at, paid_at, rejection_reason, ledger_entry_id, created_at',
        )
        .order('created_at', { ascending: false })
        .limit(50);

      if (!approvals?.length) return [];

      const listingIds = [...new Set(approvals.map(a => a.listing_id))];
      const agentIds = [...new Set(approvals.map(a => a.agent_id))];
      const approvalIds = approvals.map(a => a.id);

      // Fallback for legacy rows: pull tx_group_id from audit_logs metadata
      const missingLedger = approvals.filter(a => !a.ledger_entry_id).map(a => a.id);

      const [listingsRes, agentsRes, auditRes] = await Promise.all([
        supabase.from('house_listings').select('id, title').in('id', listingIds),
        supabase.from('profiles').select('id, full_name').in('id', agentIds),
        missingLedger.length
          ? supabase
              .from('audit_logs')
              .select('record_id, metadata, action_type')
              .in('record_id', missingLedger)
              .in('action_type', ['listing_bonus_auto_paid', 'listing_bonus_approved'])
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const listingMap = new Map((listingsRes.data || []).map(l => [l.id, l.title]));
      const agentMap = new Map((agentsRes.data || []).map(p => [p.id, p.full_name]));
      const auditTxMap = new Map<string, string>();
      (auditRes.data || []).forEach((a: any) => {
        const tx = a.metadata?.tx_group_id;
        if (tx && !auditTxMap.has(a.record_id)) auditTxMap.set(a.record_id, tx);
      });

      void approvalIds; // kept for clarity

      return approvals.map(a => ({
        ...a,
        listing_title: listingMap.get(a.listing_id) || 'Unknown',
        agent_name: agentMap.get(a.agent_id) || 'Unknown',
        audit_tx_group_id: auditTxMap.get(a.id) || null,
      })) as TimelineRow[];
    },
    staleTime: 30_000,
  });

  const visible = expanded ? (rows || []) : (rows || []).slice(0, LIMIT_COLLAPSED);
  const hiddenCount = (rows?.length || 0) - visible.length;

  return (
    <Card className="border-emerald-400/30 bg-emerald-50/30 dark:bg-emerald-950/10">
      <CardHeader className="pb-2 px-4 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          Verification Timeline
          {rows && rows.length > 0 && (
            <Badge className="bg-emerald-500/15 text-emerald-700 border-0 text-[10px]">
              {rows.length} recent
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-2">
        {isLoading && <Skeleton className="h-32 w-full rounded-xl" />}
        {!isLoading && (!rows || rows.length === 0) && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No listing verifications recorded yet
          </p>
        )}
        {visible.map(row => (
          <TimelineRow key={row.id} row={row} />
        ))}
        {hiddenCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full h-8 text-xs gap-1"
            onClick={() => setExpanded(true)}
          >
            <ChevronDown className="h-3 w-3" /> Show {hiddenCount} more
          </Button>
        )}
        {expanded && (rows?.length || 0) > LIMIT_COLLAPSED && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full h-8 text-xs gap-1"
            onClick={() => setExpanded(false)}
          >
            <ChevronUp className="h-3 w-3" /> Collapse
          </Button>
        )}
      </CardContent>
    </Card>
  );
}