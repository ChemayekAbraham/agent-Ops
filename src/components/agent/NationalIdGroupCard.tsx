/**
 * Accounts sharing this account's National ID.
 *
 * The first account to record a National ID keeps it; anyone else who
 * photographs the same card can only join with this holder's permission.
 * Only the ID number and when each account joined are shown.
 */
import { IdCard } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMyNationalIdGroup } from '@/hooks/useNationalIdLink';

/** Every National ID may carry at most this many accounts, holder included. */
const MAX_ACCOUNTS = 20;

export default function NationalIdGroupCard() {
  const { data, isLoading } = useMyNationalIdGroup();
  const rows = data ?? [];
  if (isLoading || rows.length === 0) return null;

  const nin = (rows[0] as { nin?: string }).nin ?? '';
  const used = rows.length + 1;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <IdCard className="h-4 w-4 text-primary" />
          Accounts under your National ID
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          National ID <span className="font-mono font-semibold text-foreground">{nin}</span> —{' '}
          {used} of {MAX_ACCOUNTS} accounts used, yours included.
        </p>
        <div className="divide-y divide-border rounded-xl border border-border">
          {rows.map((r, i) => {
            const row = r as { id: string; staff_decided_at?: string | null };
            return (
              <div key={row.id} className="flex items-center justify-between gap-2 p-2.5">
                <p className="text-sm font-semibold text-foreground">Account {i + 2}</p>
                <p className="text-[11px] text-muted-foreground">
                  Joined{' '}
                  {row.staff_decided_at
                    ? new Date(row.staff_decided_at).toLocaleDateString('en-GB', { dateStyle: 'medium' })
                    : '—'}
                </p>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
