import { useAgentInfo } from '@/hooks/tenantOpsWorkspace/useAgentInfo';
import { BlockShell } from './BlockShell';

const dayLabel = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function AgentBlock({ rentRequestId }: { rentRequestId: string }) {
  const { data, isLoading, error } = useAgentInfo(rentRequestId);

  return (
    <BlockShell title="Agent" isLoading={isLoading} error={error}>
      {data && (
        <div className="space-y-3 text-xs">
          <p>
            <span className="text-muted-foreground">Current agent: </span>
            <span className="font-medium">{data.currentAgentName ?? 'Unassigned'}</span>
          </p>
          {data.proxyAgentId && (
            <p>
              <span className="text-muted-foreground">Proxy: </span>
              <span className="font-medium">{data.proxyAgentName ?? data.proxyAgentId}</span>
            </p>
          )}
          <div>
            <p className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
              Assignment history
            </p>
            {data.history.length === 0 ? (
              <p className="text-muted-foreground">No transfers on record.</p>
            ) : (
              <ul className="space-y-1.5">
                {data.history.map((event) => (
                  <li key={event.id} className="border-l-2 border-border pl-2">
                    <p>
                      {event.from_agent_name ?? 'Unassigned'} → {event.to_agent_name ?? 'Unassigned'}
                    </p>
                    <p className="text-muted-foreground">
                      {dayLabel(event.occurred_at)}
                      {event.actor_name ? ` · by ${event.actor_name}` : ''}
                      {event.reason ? ` · ${event.reason}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </BlockShell>
  );
}
