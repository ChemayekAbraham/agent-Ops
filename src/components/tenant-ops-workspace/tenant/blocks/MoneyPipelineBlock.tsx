import { CheckCircle2, Circle } from 'lucide-react';
import { usePlanPipelineStages } from '@/hooks/tenantOpsWorkspace/usePlanPipelineStages';
import { BlockShell } from './BlockShell';

const dayLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null;

export function MoneyPipelineBlock({ rentRequestId }: { rentRequestId: string }) {
  const { data, isLoading, error } = usePlanPipelineStages(rentRequestId);

  return (
    <BlockShell title="Money pipeline" isLoading={isLoading} error={error}>
      {data && (
        <ol className="space-y-2">
          {data.map((stage) => (
            <li key={stage.stage_key} className="flex items-start gap-2 text-xs">
              {stage.occurred_at ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium">{stage.stage_label}</p>
                {stage.occurred_at ? (
                  <p className="text-muted-foreground">
                    {dayLabel(stage.occurred_at)}
                    {stage.actor_name ? ` · ${stage.actor_name}` : ''}
                    {stage.age_days != null ? ` · ${stage.age_days === 0 ? 'today' : `${stage.age_days}d ago`}` : ''}
                  </p>
                ) : (
                  <p className="text-muted-foreground">Not recorded</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </BlockShell>
  );
}
