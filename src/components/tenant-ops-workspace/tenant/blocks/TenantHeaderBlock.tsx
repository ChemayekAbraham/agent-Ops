import { Badge } from '@/components/ui/badge';
import { useTenantHeader } from '@/hooks/tenantOpsWorkspace/useTenantHeader';
import { BlockShell } from './BlockShell';

export function TenantHeaderBlock({ rentRequestId }: { rentRequestId: string }) {
  const { data, isLoading, error } = useTenantHeader(rentRequestId);

  return (
    <BlockShell title="Tenant" isLoading={isLoading} error={error}>
      {data && (
        <div className="flex items-start gap-3">
          <img
            src={data.avatarUrl ?? '/placeholder.svg'}
            alt=""
            className="h-14 w-14 shrink-0 rounded-full border object-cover"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-sm font-semibold">{data.fullName ?? 'Unnamed tenant'}</p>
            <p className="text-xs text-muted-foreground">{data.phone ?? '—'}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Badge variant="outline" className="text-[10px]">
                {data.planStatus ? data.planStatus.replace(/_/g, ' ') : 'status unknown'}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                Trust {data.trustScore ?? '—'}
                {data.trustTier ? ` · ${data.trustTier}` : ''}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {data.kycVisible
                  ? `KYC ${data.kycLevelLabel ?? `level ${data.kycLevel ?? '—'}`}`
                  : 'KYC not visible to your role'}
              </Badge>
            </div>
          </div>
        </div>
      )}
    </BlockShell>
  );
}
