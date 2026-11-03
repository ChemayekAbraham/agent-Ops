import { useState } from 'react';
import { ArrowUpRight, Fingerprint, Link2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAgentKycIdentityGroup } from '@/hooks/useAgentVettingQueue';
import { VETTING_STATUS_LABEL } from '@/lib/agentVetting';

export default function KycIdentityConnections({ agentId, onOpen }: { agentId: string; onOpen: (id: string) => void }) {
  const [page, setPage] = useState(0);
  const q = useAgentKycIdentityGroup(agentId, page);
  return <section className="space-y-3 border-t border-border pt-4" aria-label="National ID connections">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-semibold"><Fingerprint className="h-4 w-4 text-primary" />Agents linked to this National ID</h3>{q.data && <Badge variant="outline">{q.data.linked_count} other agents</Badge>}</div>
    {q.isLoading ? <Skeleton className="h-24 w-full" /> : q.error ? <div className="space-y-2"><p className="text-sm text-muted-foreground">Identity connections unavailable.</p><Button variant="outline" size="sm" onClick={() => q.refetch()}>Retry</Button></div> : q.data?.total ? <>
      <p className="font-mono text-xs text-muted-foreground">{q.data.masked_nin}</p>
      <div className="divide-y divide-border">{q.data.members.map((m) => <div key={m.agent_id} className="flex items-center gap-3 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">{m.relation === 'linked' ? <Link2 className="h-4 w-4" /> : <UserRound className="h-4 w-4" />}</span>
        <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{m.name ?? 'Unknown agent'}{m.agent_id === agentId && <span className="ml-1 text-xs text-muted-foreground">(selected)</span>}</p><p className="text-xs text-muted-foreground">{m.phone ?? 'No phone on file'}</p><div className="mt-1 flex flex-wrap gap-1"><Badge variant="outline" className="text-xs">{m.is_holder ? 'ID holder' : m.relation === 'own' ? 'Own ID on file' : 'Linked ID'}</Badge><Badge variant="secondary" className="text-xs">{m.status ? VETTING_STATUS_LABEL[m.status] : 'No KYC submission'}</Badge></div></div>
        {m.has_vetting && m.agent_id !== agentId && <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label={`Review ${m.name ?? 'linked agent'}`} title="Open agent review" onClick={() => onOpen(m.agent_id)}><ArrowUpRight className="h-4 w-4" /></Button>}
      </div>)}</div>
      {q.data.total > 50 && <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{page * 50 + 1}–{Math.min((page + 1) * 50, q.data.total)} of {q.data.total}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={(page + 1) * 50 >= q.data.total} onClick={() => setPage((p) => p + 1)}>Next</Button></div></div>}
    </> : <p className="text-sm text-muted-foreground">No recorded agent identity connections.</p>}
  </section>;
}