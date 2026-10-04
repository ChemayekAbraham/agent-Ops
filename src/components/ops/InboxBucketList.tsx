import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { OpsInboxBucket, OpsInboxRow, snoozeInboxRow, escalateInboxRow, useOpsInbox } from '@/hooks/useOpsInbox';
import { AlertOctagon, AlertTriangle, Eye, Sparkle, Clock, Phone, MapPin, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';

const BUCKETS: { id: OpsInboxBucket; label: string; tone: string; icon: React.ElementType }[] = [
  { id: 'critical', label: 'Critical', tone: 'bg-red-500/15 text-red-600 border-red-500/30',       icon: AlertOctagon },
  { id: 'at_risk',  label: 'At risk',  tone: 'bg-orange-500/15 text-orange-600 border-orange-500/30', icon: AlertTriangle },
  { id: 'watch',    label: 'Watch',    tone: 'bg-amber-500/15 text-amber-600 border-amber-500/30',  icon: Eye },
  { id: 'new',      label: 'New',      tone: 'bg-sky-500/15 text-sky-600 border-sky-500/30',        icon: Sparkle },
  { id: 'snoozed',  label: 'Snoozed',  tone: 'bg-muted text-muted-foreground border-border',        icon: Clock },
];

interface Props {
  opsUserId: string | null;
  onOpenBehavior: (tenantId: string) => void;
}

export function InboxBucketList({ opsUserId, onOpenBehavior }: Props) {
  const [bucket, setBucket] = useState<OpsInboxBucket>('critical');
  const { data, isLoading, refetch } = useOpsInbox(bucket, opsUserId);

  return (
    <div className="space-y-4">
      {/* Bucket pills */}
      <div className="flex flex-wrap gap-2">
        {BUCKETS.map((b) => {
          const Icon = b.icon;
          const active = b.id === bucket;
          return (
            <button
              key={b.id}
              onClick={() => setBucket(b.id)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-medium transition ${
                active ? b.tone : 'bg-card text-muted-foreground border-border hover:bg-muted'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {b.label}
            </button>
          );
        })}
      </div>

      {/* Card list */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Nothing in <strong>{BUCKETS.find((b) => b.id === bucket)?.label}</strong> right now. 🎉
        </div>
      ) : (
        <ul className="space-y-2">
          {data.map((row) => (
            <InboxCard
              key={row.tenant_id}
              row={row}
              onOpenBehavior={onOpenBehavior}
              onAfterAction={() => refetch()}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function InboxCard({
  row,
  onOpenBehavior,
  onAfterAction,
}: {
  row: OpsInboxRow;
  onOpenBehavior: (tenantId: string) => void;
  onAfterAction: () => void;
}) {
  return (
    <li
      className="rounded-xl border border-border bg-card p-4 hover:bg-muted/40 transition cursor-pointer"
      onClick={() => onOpenBehavior(row.tenant_id)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm truncate">{row.full_name || 'Unknown tenant'}</p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
            <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{row.phone || '—'}</span>
            <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{row.city || '—'}</span>
            <span>Trust {row.trust_score}</span>
          </div>
          <p className="text-sm mt-2 text-foreground">{row.reason}</p>
        </div>
        <Badge variant="outline" className="shrink-0">{row.severity}</Badge>
      </div>

      <div className="flex flex-wrap gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
        <Button
          size="sm"
          className="gap-1"
          onClick={() => onOpenBehavior(row.tenant_id)}
        >
          Act <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await snoozeInboxRow(row.tenant_id, 24);
            toast.success('Snoozed 24h');
            onAfterAction();
          }}
        >
          Snooze 24h
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await escalateInboxRow(row.tenant_id);
            toast.success('Escalated');
            onAfterAction();
          }}
        >
          Escalate
        </Button>
      </div>
    </li>
  );
}
