import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { History } from 'lucide-react';

type Row = {
  audit_id: string;
  changed_at: string;
  actor_id: string | null;
  actor_name: string | null;
  action_type: string;
  reason: string | null;
  record_id: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
};

const FIELD_LABELS: Record<string, string> = {
  name: 'Landlord name',
  phone: 'Phone',
  mobile_money_number: 'MoMo number',
  mobile_money_name: 'MoMo name',
  monthly_rent: 'Monthly rent',
  number_of_rooms: 'Rooms',
  property_address: 'Property address',
  house_number: 'House number',
  bank_name: 'Bank name',
  account_number: 'Bank account #',
  caretaker_name: 'Caretaker name',
  caretaker_phone: 'Caretaker phone',
  electricity_meter_number: 'Electricity meter #',
  water_meter_number: 'Water meter #',
  description: 'Description / notes',
  region: 'Region',
  district: 'District',
  county: 'County',
  sub_county: 'Sub-county',
  village: 'Village',
  ug_village_id: 'Official village',
};

const ACTION_LABELS: Record<string, string> = {
  ops_update_landlord: 'Officer edit',
  landlord_material_change_applied: 'Agreement-backed change applied',
  landlord_material_change_blocked: 'Change blocked (no signed document)',
  'ops.update_landlord_smartphone': 'Smartphone status change',
};

const show = (v: string | null) => (v == null || v.trim() === '' ? '—' : v);

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Read-only landlord edit trail for ops officers. Reads the existing
 * audit_logs records through ops_landlord_change_history — nothing is written.
 */
export function LandlordChangeHistory({
  landlordId,
  visible,
}: {
  landlordId: string;
  visible: boolean;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['landlord-change-history', landlordId],
    enabled: visible && !!landlordId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('ops_landlord_change_history' as any, {
        p_landlord_id: landlordId,
        p_limit: 60,
      } as any);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  if (!visible) return null;

  // Group the per-field rows back into one entry per saved edit.
  const groups = new Map<string, { head: Row; fields: Row[] }>();
  for (const r of data ?? []) {
    const g = groups.get(r.audit_id) ?? { head: r, fields: [] };
    if (r.field_name) g.fields.push(r);
    groups.set(r.audit_id, g);
  }
  const entries = Array.from(groups.values());

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <History className="h-4 w-4 text-primary" /> Landlord change history
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No recorded changes yet.</p>
      ) : (
        <ul className="divide-y divide-border/40">
          {entries.map(({ head, fields }) => (
            <li key={head.audit_id} className="py-2 space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="text-xs font-medium">
                  {ACTION_LABELS[head.action_type] ?? head.action_type}
                </span>
                <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                  {when(head.changed_at)}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                By {show(head.actor_name)}
              </p>
              {fields.length > 0 && (
                <ul className="space-y-0.5">
                  {fields.map((f) => (
                    <li key={f.audit_id + f.field_name} className="text-[11px] break-words">
                      <span className="font-medium">
                        {FIELD_LABELS[f.field_name!] ?? f.field_name}:
                      </span>{' '}
                      <span className="text-muted-foreground">{show(f.old_value)}</span>
                      <span className="mx-1">→</span>
                      <span>{show(f.new_value)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {head.reason && (
                <p className="text-[11px] text-muted-foreground italic">Reason: {head.reason}</p>
              )}
              <p className="text-[10px] text-muted-foreground/70 font-mono">
                Ref {head.audit_id.slice(0, 8)} · landlord {head.record_id.slice(0, 8)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default LandlordChangeHistory;
