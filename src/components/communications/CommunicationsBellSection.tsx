import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useCommunicationInbox } from '@/hooks/useCrmCommunications';
import { communicationDashboardRole, type Communication } from '@/lib/crmCommunications';
import { communicationIcons } from './CommunicationDialog';

export const OPEN_COMMUNICATION_EVENT = 'welile:open-communication';

/** Platform communications for the current dashboard, shared with CommunicationGate's inbox query. */
export function useBellCommunications() {
  const { user, role, loading, rolesResolved, roles } = useAuth();
  const { pathname } = useLocation();
  const dashboardRole = communicationDashboardRole(pathname, role);
  const eligible = !!user && !loading && rolesResolved && !!dashboardRole && roles.includes(dashboardRole);
  const query = useCommunicationInbox(dashboardRole, eligible);
  const rows = eligible ? query.data ?? [] : [];
  return { rows, unread: rows.filter(r => !r.acknowledged_at).length };
}

export function CommunicationsBellSection({ onSelect }: { onSelect?: () => void }) {
  const { rows } = useBellCommunications();
  if (!rows.length) return null;
  const open = (row: Communication) => {
    onSelect?.();
    window.setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN_COMMUNICATION_EVENT, { detail: row })), 150);
  };
  return (
    <div className="px-2 pb-2 space-y-1 border-b border-border/50">
      <p className="px-2 pt-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Communications</p>
      {rows.map(row => {
        const Icon = communicationIcons[row.communication_type];
        return (
          <button key={row.id} type="button" onClick={() => open(row)}
            className={`w-full text-left px-3 py-2.5 rounded-xl flex gap-2.5 hover:bg-accent/60 ${row.acknowledged_at ? 'opacity-60' : 'bg-primary/5'}`}>
            <Icon className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
            <span className="min-w-0 text-xs font-semibold text-foreground break-words">
              {row.title}
              <span className="block text-[10px] font-normal text-muted-foreground">{row.acknowledged_at ? 'Acknowledged' : 'New'}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
