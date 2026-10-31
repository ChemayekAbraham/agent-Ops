/** One tenant line, shared by the single-place list and the combined selection view. */
import { Phone, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { TlbTenant } from '@/hooks/useTenantLocationsBrowser';

export type TenantRowData = Omit<TlbTenant, 'total_count'>;

interface Props {
  tenant: TenantRowData;
  /** Unmapped tenants show the free-text location that was recorded for them. */
  unmapped?: boolean;
  onSelectTenant?: (tenantId: string, tenantName: string) => void;
}

export function TenantLocationTenantRow({ tenant: t, unmapped = false, onSelectTenant }: Props) {
  return (
    <li
      className={`rounded-lg border border-border bg-card p-3 ${
        onSelectTenant ? 'cursor-pointer transition-colors hover:bg-accent/50' : ''
      }`}
      role={onSelectTenant ? 'button' : undefined}
      tabIndex={onSelectTenant ? 0 : undefined}
      onClick={onSelectTenant ? () => onSelectTenant(t.tenant_id, t.tenant_name) : undefined}
      onKeyDown={onSelectTenant ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelectTenant(t.tenant_id, t.tenant_name);
        }
      } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate flex items-center gap-1.5">
            <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            {t.tenant_name}
          </p>
          <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
            <Phone className="h-3 w-3" />{t.tenant_phone || '-'}
            {t.agent_name && <span className="truncate"> · Agent: {t.agent_name}</span>}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">
            {unmapped
              ? `Recorded location: ${t.legacy_location || 'none recorded'}`
              : [t.village_name, t.parish_name, t.subcounty_name, t.county_name, t.district_name, t.region]
                  .filter(Boolean).join(', ')}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Badge
            className={t.is_active
              ? 'bg-success/10 text-success text-[10px]'
              : 'bg-muted text-muted-foreground text-[10px]'}
          >
            {t.is_active ? 'Active' : 'Inactive'}
          </Badge>
          {t.latest_status && (
            <span className="text-[10px] text-muted-foreground">
              {t.latest_status.replace(/_/g, ' ')}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

export default TenantLocationTenantRow;
