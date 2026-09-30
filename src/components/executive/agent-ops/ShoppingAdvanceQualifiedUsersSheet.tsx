import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';

type Row = {
  user_id: string; full_name: string | null; phone: string | null; email: string | null;
  national_id: string | null; occupation: string | null; primary_persona: string | null;
  verified: boolean | null; phone_verified: boolean | null; is_frozen: boolean | null;
  created_at: string | null; last_active_at: string | null;
  continent: string | null; country: string | null; region: string | null; district: string | null;
  sub_county: string | null; parish: string | null; village: string | null; town: string | null;
  city: string | null; landmark: string | null;
  residence_lat: number | null; residence_lng: number | null; residence_updated_at: string | null;
  location_source: string | null; mobile_money_provider: string | null; mobile_money_number: string | null;
  first_transfer_at: string | null; last_transfer_at: string | null;
};

const d = (v: string | null) => (v ? new Date(v).toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala' }) : '—');
const t = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

export function ShoppingAdvanceQualifiedUsersSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [q, setQ] = useState('');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-ops-shopping-advance-qualified-profiles'],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_shopping_advance_qualified_profiles');
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || !data) return data ?? [];
    return data.filter((r) =>
      [r.full_name, r.phone, r.email, r.country, r.region, r.district, r.sub_county, r.parish, r.village, r.town]
        .some((v) => v?.toLowerCase().includes(s)));
  }, [data, q]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Users qualified through wallet transfers — by location</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-3">
          <Input placeholder="Search name, phone, country, district, village…" value={q} onChange={(e) => setQ(e.target.value)} />
          <p className="text-sm text-muted-foreground">
            {isLoading ? 'Loading…' : isError ? 'Unavailable' : `${rows.length.toLocaleString('en-US')} users`}
            {' · '}County is not recorded in user profiles, so it shows “—”.
          </p>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted text-left">
                <tr>
                  {['Name','Phone','Email','National ID','Occupation','Role','Verified','Frozen','Joined','Last active',
                    'Continent','Country','Region','District','County','Sub county','Parish','Village','Town/City','Landmark',
                    'GPS','Location source','Mobile money','First transfer','Last transfer'].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const gps = r.residence_lat != null && r.residence_lng != null;
                  return (
                    <tr key={r.user_id} className="border-t border-border">
                      <td className="whitespace-nowrap px-2 py-1.5 font-medium">{t(r.full_name)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{t(r.phone)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{t(r.email)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{t(r.national_id)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{t(r.occupation)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{t(r.primary_persona)}</td>
                      <td className="px-2 py-1.5">{r.verified ? 'Yes' : 'No'}</td>
                      <td className="px-2 py-1.5">{r.is_frozen ? 'Yes' : 'No'}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{d(r.created_at)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{d(r.last_active_at)}</td>
                      <td className="px-2 py-1.5">{t(r.continent)}</td>
                      <td className="px-2 py-1.5">{t(r.country)}</td>
                      <td className="px-2 py-1.5">{t(r.region)}</td>
                      <td className="px-2 py-1.5">{t(r.district)}</td>
                      <td className="px-2 py-1.5">—</td>
                      <td className="px-2 py-1.5">{t(r.sub_county)}</td>
                      <td className="px-2 py-1.5">{t(r.parish)}</td>
                      <td className="px-2 py-1.5">{t(r.village)}</td>
                      <td className="px-2 py-1.5">{t(r.town ?? r.city)}</td>
                      <td className="px-2 py-1.5">{t(r.landmark)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        {gps ? (
                          <a className="text-primary underline" target="_blank" rel="noreferrer"
                            href={`https://www.google.com/maps?q=${r.residence_lat},${r.residence_lng}`}>
                            {Number(r.residence_lat).toFixed(5)}, {Number(r.residence_lng).toFixed(5)}
                          </a>
                        ) : '—'}
                      </td>
                      <td className="px-2 py-1.5">{t(r.location_source)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{r.mobile_money_number ? `${t(r.mobile_money_provider)} ${r.mobile_money_number}` : '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{d(r.first_transfer_at)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{d(r.last_transfer_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
