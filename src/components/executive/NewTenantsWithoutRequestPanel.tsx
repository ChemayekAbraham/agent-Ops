import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { User, Phone, Search, UserPlus2, Calendar, AlertCircle, MapPin, ChevronDown } from 'lucide-react';
import { format } from 'date-fns';
import { formatLocation, locationHaystack } from '@/lib/locationText';

/**
 * Surfaces tenants that an agent registered (via referral / quick-register flows)
 * but for whom NO `rent_requests` row has ever been created.
 *
 * Without this panel these tenants are invisible to Agent Ops because the
 * normal pipeline queue is keyed off `rent_requests.status='pending'`.
 */
export function NewTenantsWithoutRequestPanel() {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['agent-ops-orphan-tenants'],
    queryFn: async () => {
      // 1. Pull recent agent-referred tenants
      const { data: refs, error: refErr } = await supabase
        .from('referrals')
        .select('referred_id, referrer_id, created_at')
        .order('created_at', { ascending: false })
        .limit(500);
      if (refErr) throw refErr;
      if (!refs || refs.length === 0) return [];

      const tenantIds = [...new Set(refs.map(r => r.referred_id).filter(Boolean))];
      const referrerIds = [...new Set(refs.map(r => r.referrer_id).filter(Boolean))];

      // 2. Find which of these tenants ALREADY have a rent_request → exclude them
      const { data: existing } = await supabase
        .from('rent_requests')
        .select('tenant_id')
        .in('tenant_id', tenantIds);
      const hasRequest = new Set((existing || []).map(r => r.tenant_id));

      const orphanIds = tenantIds.filter(id => !hasRequest.has(id));
      if (orphanIds.length === 0) return [];

      // 3. Resolve names/phones for tenants and the agents who referred them
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone, created_at, region, district, sub_county, parish, village, city, town, landmark')
        .in('id', [...new Set([...orphanIds, ...referrerIds])]);
      const pMap = new Map((profiles || []).map(p => [p.id, p]));

      return refs
        .filter(r => !hasRequest.has(r.referred_id) && pMap.has(r.referred_id))
        .map(r => {
          const tenant = pMap.get(r.referred_id);
          const agent = pMap.get(r.referrer_id);
          const tenantAddress = formatLocation([
            (tenant as any)?.landmark,
            (tenant as any)?.village,
            (tenant as any)?.parish,
            (tenant as any)?.sub_county,
            (tenant as any)?.city || (tenant as any)?.town,
            (tenant as any)?.district,
            (tenant as any)?.region,
          ]);
          return {
            tenant_id: r.referred_id,
            tenant_name: tenant?.full_name || 'Unknown',
            tenant_phone: tenant?.phone || '',
            tenant_district: (tenant as any)?.district || '',
            tenant_address: tenantAddress,
            agent_id: r.referrer_id,
            agent_name: agent?.full_name || 'Unknown agent',
            agent_phone: agent?.phone || '',
            registered_at: r.created_at,
            search_text: locationHaystack([
              tenant?.full_name,
              tenant?.phone,
              agent?.full_name,
              tenantAddress,
            ]),
          };
        });
    },
    staleTime: 60_000,
  });

  const q = search.toLowerCase().trim();
  const filtered = rows.filter(r => !q || r.search_text.includes(q));
  const agentCount = new Set(rows.map(r => r.agent_id).filter(Boolean)).size;
  const districtCount = new Set(rows.map(r => r.tenant_district).filter(Boolean)).size;

  if (isLoading) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 text-center text-xs text-muted-foreground">
          Loading newly registered tenants…
        </CardContent>
      </Card>
    );
  }

  if (rows.length === 0) {
    return null;
  }

  return (
    <Card className="border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/10 transition-all">
      <CardContent className="p-2.5 sm:p-3">
        <Collapsible open={open} onOpenChange={setOpen} className="space-y-2.5">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-between w-full text-left hover:opacity-90 transition-opacity cursor-pointer group gap-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className="p-1 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-400 shrink-0">
                  <UserPlus2 className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-semibold text-foreground group-hover:text-primary transition-colors truncate">
                    New tenants without a rent request
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge variant="primary" size="sm">{rows.length}</Badge>
                <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
              </div>
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent className="space-y-3 pt-1">
            <p className="text-[11px] text-muted-foreground leading-snug">
              Tenants agents added to the platform but who have not yet had a rent request submitted.
              Follow up with the agent to capture the rent details.
            </p>

            {/* Summary stats */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-border bg-card px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Tenants</p>
                <p className="text-sm font-bold">{rows.length}</p>
              </div>
              <div className="rounded-lg border border-border bg-card px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Agents</p>
                <p className="text-sm font-bold">{agentCount}</p>
              </div>
              <div className="rounded-lg border border-border bg-card px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Districts</p>
                <p className="text-sm font-bold">{districtCount}</p>
              </div>
            </div>

            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search tenant, phone, agent, district or address…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8 h-8 text-xs bg-background"
              />
            </div>

            {filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-2">No matches.</p>
            ) : (
              <div className="space-y-2 pr-1 max-h-[380px] overflow-y-auto">
                {filtered.slice(0, 50).map(row => (
                  <div
                    key={row.tenant_id}
                    className="rounded-lg border border-border bg-card p-2.5 flex items-start justify-between gap-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-sm font-semibold truncate">{row.tenant_name}</span>
                      </div>
                      {row.tenant_phone && (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <Phone className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-[11px] text-muted-foreground">{row.tenant_phone}</span>
                        </div>
                      )}
                      {row.tenant_address && (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-[11px] text-muted-foreground truncate">{row.tenant_address}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Badge variant="outline" size="sm" className="text-[10px] py-0 px-1.5 font-normal">
                          Agent: {row.agent_name}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        Registered {format(new Date(row.registered_at), 'dd MMM yyyy')}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700">
                        <AlertCircle className="h-3 w-3" /> No request
                      </span>
                    </div>
                  </div>
                ))}
                {filtered.length > 50 && (
                  <p className="text-[10px] text-center text-muted-foreground pt-1">
                    Showing first 50 of {filtered.length}
                  </p>
                )}
              </div>
            )}

            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border bg-muted/30 px-3 py-1.5 text-xs font-semibold hover:bg-muted/50 cursor-pointer"
              >
                Fold panel
                <ChevronDown className="h-4 w-4 rotate-180" />
              </Button>
            </CollapsibleTrigger>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}