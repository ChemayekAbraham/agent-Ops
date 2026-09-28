import { usePlaceInfo } from '@/hooks/tenantOpsWorkspace/usePlaceInfo';
import { BlockShell } from './BlockShell';

const Field = ({ label, value }: { label: string; value: string | null | undefined }) => (
  <div>
    <span className="text-muted-foreground">{label}</span>
    <p className="font-medium">{value || '—'}</p>
  </div>
);

export function PlaceBlock({ rentRequestId }: { rentRequestId: string }) {
  const { data, isLoading, error } = usePlaceInfo(rentRequestId);

  return (
    <BlockShell title="Place" isLoading={isLoading} error={error}>
      {data && (
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <Field label="Country" value={data.adminChain?.country} />
            <Field label="Region" value={data.adminChain?.region} />
            <Field label="District" value={data.adminChain?.district ?? data.house?.district} />
            <Field label="Ward" value={data.adminChain?.ward} />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <Field
              label="GPS"
              value={data.latitude != null && data.longitude != null ? `${data.latitude}, ${data.longitude}` : null}
            />
            <Field label="House" value={data.house?.title ?? data.house?.address} />
            <Field label="Landlord" value={data.landlord?.name} />
            <Field label="LC1" value={data.lc1?.name} />
          </div>
          {data.lc1 && (
            <p className="text-muted-foreground">
              LC1 {data.lc1.name ?? '—'} · {data.lc1.phone ?? '—'} · {data.lc1.verified ? 'verified' : 'not verified'}
            </p>
          )}
        </div>
      )}
    </BlockShell>
  );
}
