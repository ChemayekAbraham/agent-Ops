import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { History } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface AuditRow {
  id: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

/** Human-friendly labels for the audited profile fields. */
const FIELD_LABELS: Record<string, string> = {
  full_name: 'Full name',
  phone: 'Phone',
  email: 'Email',
  avatar_url: 'Profile photo',
  national_id: 'National ID',
  mobile_money_number: 'Mobile money number',
  mobile_money_provider: 'Mobile money provider',
  continent: 'Continent',
  country: 'Country',
  region: 'Region',
  district: 'District',
  city: 'City',
  town: 'Town',
  sub_county: 'Ward (sub-county)',
  parish: 'Cell (parish)',
  village: 'Village',
  landmark: 'Landmark',
  residence_lat: 'Residence GPS (lat)',
  residence_lng: 'Residence GPS (lng)',
  primary_persona: 'Primary role',
  occupation: 'Occupation',
  has_smartphone: 'Has smartphone',
  address_complete: 'Profile completed',
  referrer_id: 'Referring agent',
  territory: 'Territory',
  agent_type: 'Agent type',
};

const prettyValue = (v: string | null) => {
  if (v === null || v.trim() === '') return '—';
  if (v === 'true') return 'Yes';
  if (v === 'false') return 'No';
  if (v.length > 40) return v.slice(0, 40) + '…';
  return v;
};

const prettyTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

export default function ProfileChangeHistory({ userId }: { userId: string }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase
        .from('profile_field_audit')
        .select('id, field_name, old_value, new_value, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(30);
      if (active) setRows((data as AuditRow[]) || []);
    })();
    return () => { active = false; };
  }, [userId]);

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-4 w-4 text-primary" /> Profile change history
        </CardTitle>
        <CardDescription>
          Every saved change to your profile is recorded system-wide.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows === null ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-10 w-full rounded-xl" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border/40">
            {rows.map((r) => (
              <li key={r.id} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{FIELD_LABELS[r.field_name] || r.field_name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {prettyValue(r.old_value)} <span className="mx-1">→</span> {prettyValue(r.new_value)}
                  </p>
                </div>
                <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                  {prettyTime(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}