import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { Search, UserCog, Phone, Mail, MapPin, Calendar, FileText, Users } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { ProxyAgentRow } from '@/hooks/usePromissoryOpsReport';

const PAGE_SIZE = 10;

const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join('') || '?';

const statusTone = (status: string) =>
  status === 'approved'
    ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
    : status === 'pending'
    ? 'bg-amber-100 text-amber-700 border-amber-200'
    : 'bg-muted text-muted-foreground border-border';

export function ProxyAgentPerformanceList({ agents, isLoading }: { agents: ProxyAgentRow[]; isLoading?: boolean }) {
  const [search, setSearch] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<ProxyAgentRow | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(a =>
      [a.name, a.phone, a.email, a.district, a.region, a.lead_partner_name, a.invite_code]
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(q))
    );
  }, [agents, search]);

  const page = filtered.slice(0, visible);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <UserCog className="h-4 w-4 text-primary" />
          Proxy agents ({filtered.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => { setSearch(e.target.value); setVisible(PAGE_SIZE); }}
            placeholder="Search proxy agents by name, phone, lead or district..."
            className="pl-9"
          />
        </div>

        {/* Desktop table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Notes</th>
                <th className="py-2 pr-3 font-medium">Partners</th>
                <th className="py-2 pr-3 font-medium">Lead partner</th>
                <th className="py-2 pr-3 font-medium text-right">Expected</th>
                <th className="py-2 pr-3 font-medium text-right">Came in</th>
                <th className="py-2 pr-3 font-medium">Joined</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {page.map(a => (
                <tr
                  key={a.agent_user_id}
                  className="border-b last:border-0 cursor-pointer hover:bg-muted/40"
                  onClick={() => setSelected(a)}
                >
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar className="h-6 w-6">
                        {a.avatar_url && <AvatarImage src={a.avatar_url} alt={a.name} />}
                        <AvatarFallback className="text-[10px]">{initialsOf(a.name)}</AvatarFallback>
                      </Avatar>
                      <span className="font-medium truncate max-w-[160px]">{a.name}</span>
                    </div>
                  </td>
                  <td className="py-2 pr-3">{a.notes_count}</td>
                  <td className="py-2 pr-3">{a.partners_count}</td>
                  <td className="py-2 pr-3 truncate max-w-[140px]">{a.lead_partner_name || '—'}</td>
                  <td className="py-2 pr-3 text-right font-medium"><CompactAmount value={Number(a.amount_expected)} /></td>
                  <td className="py-2 pr-3 text-right font-medium text-emerald-600"><CompactAmount value={Number(a.amount_collected)} /></td>
                  <td className="py-2 pr-3">{a.joined_at ? format(new Date(a.joined_at), 'dd MMM yyyy') : '—'}</td>
                  <td className="py-2">
                    <Badge variant="outline" className={cn('text-[10px] capitalize', statusTone(a.status))}>{a.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden space-y-2">
          {page.map(a => (
            <button
              key={a.agent_user_id}
              type="button"
              onClick={() => setSelected(a)}
              className="w-full text-left rounded-lg border p-3 hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Avatar className="h-8 w-8">
                  {a.avatar_url && <AvatarImage src={a.avatar_url} alt={a.name} />}
                  <AvatarFallback className="text-[10px]">{initialsOf(a.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{a.name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {a.notes_count} notes · {a.partners_count} partners
                  </p>
                </div>
                <Badge variant="outline" className={cn('text-[10px] capitalize shrink-0', statusTone(a.status))}>{a.status}</Badge>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <span className="text-muted-foreground">Expected: </span>
                  <span className="font-medium"><CompactAmount value={Number(a.amount_expected)} /></span>
                </div>
                <div>
                  <span className="text-muted-foreground">Came in: </span>
                  <span className="font-medium text-emerald-600"><CompactAmount value={Number(a.amount_collected)} /></span>
                </div>
                <div className="col-span-2 text-muted-foreground truncate">
                  Lead: {a.lead_partner_name || '—'} · Joined {a.joined_at ? format(new Date(a.joined_at), 'dd MMM yyyy') : '—'}
                </div>
              </div>
            </button>
          ))}
        </div>

        {isLoading && <p className="text-center text-xs text-muted-foreground py-4">Loading proxy agents…</p>}
        {!isLoading && filtered.length === 0 && (
          <p className="text-center text-xs text-muted-foreground py-4">No proxy agents found</p>
        )}
        {visible < filtered.length && (
          <Button variant="outline" size="sm" className="w-full" onClick={() => setVisible(v => v + PAGE_SIZE)}>
            Load 10 more ({filtered.length - visible} left)
          </Button>
        )}
      </CardContent>

      <Sheet open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}>
        <SheetContent side="bottom" className="h-[80vh] rounded-t-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 text-base">
              <UserCog className="h-4 w-4 text-primary" />
              Proxy agent profile
            </SheetTitle>
          </SheetHeader>
          {selected && (
            <div className="space-y-4 mt-4 pb-8">
              <div className="flex items-center gap-3">
                <Avatar className="h-14 w-14">
                  {selected.avatar_url && <AvatarImage src={selected.avatar_url} alt={selected.name} />}
                  <AvatarFallback>{initialsOf(selected.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="font-semibold truncate">{selected.name}</p>
                  <Badge variant="outline" className={cn('text-[10px] capitalize mt-1', statusTone(selected.status))}>
                    {selected.status}
                  </Badge>
                </div>
              </div>

              <Card>
                <CardContent className="p-3 space-y-1.5 text-sm">
                  <p className="text-xs font-medium text-muted-foreground uppercase">Contact & identity</p>
                  {selected.phone && <p className="flex items-center gap-2"><Phone className="h-3.5 w-3.5 text-muted-foreground" />{selected.phone}</p>}
                  {selected.email && <p className="flex items-center gap-2 break-all"><Mail className="h-3.5 w-3.5 text-muted-foreground" />{selected.email}</p>}
                  {(selected.district || selected.region) && (
                    <p className="flex items-center gap-2"><MapPin className="h-3.5 w-3.5 text-muted-foreground" />{[selected.district, selected.region].filter(Boolean).join(', ')}</p>
                  )}
                  <p className="flex items-center gap-2"><Calendar className="h-3.5 w-3.5 text-muted-foreground" />Joined {selected.joined_at ? format(new Date(selected.joined_at), 'dd MMM yyyy') : '—'}</p>
                  {selected.nin && <p className="text-xs text-muted-foreground">NIN: {selected.nin}</p>}
                  {selected.invite_code && <p className="text-xs text-muted-foreground">Invite code: {selected.invite_code}</p>}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-3 space-y-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase">Financials</p>
                  <div className="grid grid-cols-2 gap-3 text-center">
                    <div className="rounded-md bg-muted/50 p-2">
                      <p className="text-xs text-muted-foreground">Amount expected</p>
                      <p className="font-bold text-sm"><CompactAmount value={Number(selected.amount_expected)} /></p>
                    </div>
                    <div className="rounded-md bg-emerald-50 p-2">
                      <p className="text-xs text-muted-foreground">Amount came in</p>
                      <p className="font-bold text-sm text-emerald-700"><CompactAmount value={Number(selected.amount_collected)} /></p>
                    </div>
                    <div className="rounded-md bg-muted/50 p-2">
                      <p className="text-xs text-muted-foreground flex items-center justify-center gap-1"><FileText className="h-3 w-3" />Promissory notes</p>
                      <p className="font-bold text-sm">{selected.notes_count}</p>
                    </div>
                    <div className="rounded-md bg-muted/50 p-2">
                      <p className="text-xs text-muted-foreground flex items-center justify-center gap-1"><Users className="h-3 w-3" />Partners came in</p>
                      <p className="font-bold text-sm">{selected.partners_count}</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">Lead partner: {selected.lead_partner_name || 'Not attached'}</p>
                </CardContent>
              </Card>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </Card>
  );
}
