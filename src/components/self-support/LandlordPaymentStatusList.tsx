import { Badge } from '@/components/ui/badge';
import { useMyLandlordPayments } from '@/hooks/useSelfSupportDirect';
import { landlordPaymentCopy, hoursLeft, type CopyTone, type LandlordPayment } from '@/lib/selfSupportDirect';

const TONE_VARIANT: Record<CopyTone, 'secondary' | 'success' | 'outline' | 'warning'> = {
  pending: 'secondary',
  success: 'success',
  neutral: 'outline',
  warning: 'warning',
};

/** Partner-funded Rent Plans waiting for (or past) their landlord payment, for the partner or the agent. */
export function LandlordPaymentStatusList({ role, title }: { role: LandlordPayment['role']; title: string }) {
  const { data } = useMyLandlordPayments();
  const rows = (data ?? []).filter((r) => r.role === role);
  if (rows.length === 0) return null;
  return (
    <section className="space-y-2 rounded-2xl border bg-card p-3 shadow-sm" aria-label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="space-y-2">
        {rows.map((row) => {
          const copy = landlordPaymentCopy(row);
          return (
            <li key={row.id} className="rounded-xl border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{row.tenant_first_name?.trim() || 'Rent Plan'}</span>
                <div className="flex items-center gap-2">
                  {copy.state === 'waiting' && role === 'partner' ? (
                    <span className="text-xs text-muted-foreground">{hoursLeft(row.expires_at)} h left</span>
                  ) : null}
                  <Badge variant={TONE_VARIANT[copy.tone]}>{copy.label}</Badge>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{copy.detail}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
