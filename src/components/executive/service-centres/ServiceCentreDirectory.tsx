import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Building2, ExternalLink, Loader2, MapPin, Phone, Search } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { useServiceCentres, SC_STATUS_META, mapsUrl, type ServiceCentre, type ServiceCentreStatus } from '@/hooks/useServiceCentres';
import { ServiceCentreCandidatesPanel } from './ServiceCentreCandidatesPanel';
import { ServiceCentreDetailDialog } from './ServiceCentreDetailDialog';


const FILTERS: ('all' | ServiceCentreStatus)[] = ['all', 'pending', 'verified', 'paid', 'rejected'];
const PAGE = 15;

const initials = (name: string) =>
  (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

/** Avatars for every agent in the register, fetched in one request (never per row). */
function useAgentAvatars(agentIds: string[]) {
  const key = useMemo(() => Array.from(new Set(agentIds)).sort(), [agentIds]);
  return useQuery({
    queryKey: ['sc-agent-avatars', key.length, key[0] ?? ''],
    enabled: key.length > 0,
    staleTime: 300_000,
    queryFn: async (): Promise<Record<string, string | null>> => {
      const map: Record<string, string | null> = {};
      const CHUNK = 500;
      for (let i = 0; i < key.length; i += CHUNK) {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, avatar_url')
          .in('id', key.slice(i, i + CHUNK));
        if (error) throw error;
        (data || []).forEach((p: any) => { map[p.id] = p.avatar_url ?? null; });
      }
      return map;
    },
  });
}

/** Searchable register of every Service Centre, plus the agents close to earning one. */
export function ServiceCentreDirectory() {
  const { data: centres, isLoading } = useServiceCentres();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | ServiceCentreStatus>('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ServiceCentre | null>(null);

  const { data: avatars } = useAgentAvatars((centres || []).map((c) => c.agent_id));

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (centres || []).filter((c) => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (!term) return true;
      return [c.agent_name, c.agent_phone, c.location_name].some((v) => (v || '').toLowerCase().includes(term));
    });
  }, [centres, q, filter]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const pageRows = rows.slice(page * PAGE, page * PAGE + PAGE);

  /** Every photo submitted by the selected agent — a centre often has more than one. */
  const selectedPhotos = useMemo(() => {
    if (!selected) return [] as ServiceCentre[];
    return (centres || []).filter((c) => c.agent_id === selected.agent_id && !!c.photo_url);
  }, [centres, selected]);

  return (
    <div className="space-y-4">
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Building2 className="h-4 w-4 text-primary" />
            Service Centre Directory
            <span className="ml-auto text-xs font-normal text-muted-foreground">{rows.length} shown</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(0); }}
              placeholder="Search agent, phone or location"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? 'default' : 'outline'}
                className="h-7 text-xs capitalize"
                onClick={() => { setFilter(f); setPage(0); }}
              >
                {f === 'all' ? 'All' : SC_STATUS_META[f].label}
              </Button>
            ))}
          </div>

          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No service centres match this view.</p>
          ) : (
            <>
              {/* Desktop list */}
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead>Phone number</TableHead>
                      <TableHead>Service centre location</TableHead>
                      <TableHead>Map</TableHead>
                      <TableHead>Request date</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((c) => (
                      <TableRow key={c.id} className="cursor-pointer" onClick={() => setSelected(c)}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Avatar className="h-8 w-8">
                              {avatars?.[c.agent_id] && <AvatarImage src={avatars[c.agent_id]!} alt={c.agent_name} />}
                              <AvatarFallback className="text-[10px]">{initials(c.agent_name)}</AvatarFallback>
                            </Avatar>
                            <span className="text-sm font-medium">{c.agent_name}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{c.agent_phone || '—'}</TableCell>
                        <TableCell className="max-w-[260px] text-xs">
                          <span className="line-clamp-2">{c.location_name || 'No description'}</span>
                        </TableCell>
                        <TableCell>
                          <a
                            href={mapsUrl(c.latitude, c.longitude)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <MapPin className="h-3 w-3" />Map<ExternalLink className="h-3 w-3" />
                          </a>
                        </TableCell>
                        <TableCell className="text-xs">{format(new Date(c.created_at), 'dd MMM yyyy')}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('border-0 text-[10px]', SC_STATUS_META[c.status].className)}>
                            {SC_STATUS_META[c.status].label}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile list */}
              <div className="space-y-2 md:hidden">
                {pageRows.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelected(c)}
                    className="w-full rounded-xl border border-border p-3 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <Avatar className="h-8 w-8">
                        {avatars?.[c.agent_id] && <AvatarImage src={avatars[c.agent_id]!} alt={c.agent_name} />}
                        <AvatarFallback className="text-[10px]">{initials(c.agent_name)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{c.agent_name}</p>
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Phone className="h-3 w-3" />{c.agent_phone || '—'}
                        </p>
                      </div>
                      <Badge variant="outline" className={cn('ml-auto shrink-0 border-0 text-[10px]', SC_STATUS_META[c.status].className)}>
                        {SC_STATUS_META[c.status].label}
                      </Badge>
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{c.location_name || 'No description'}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">{format(new Date(c.created_at), 'dd MMM yyyy')}</p>
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-muted-foreground">Page {page + 1} of {pages}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <ServiceCentreCandidatesPanel />

      <ServiceCentreDetailDialog
        centre={selected}
        photos={selectedPhotos}
        avatarUrl={selected ? avatars?.[selected.agent_id] ?? null : null}
        onClose={() => setSelected(null)}
      />

    </div>
  );
}
