import { FileSearch, Link2, MapPin, MessageSquare } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { VETTING_STATUS_LABEL, type VettingQueueRow } from '@/lib/agentVetting';

const stamp = (value: string) => new Date(value).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' });

export default function KycReviewTable({ rows, links, photos, selectedId, onOpen }: {
  rows: VettingQueueRow[]; links?: Record<string, number>; photos?: Record<string, string | null>;
  selectedId: string | null; onOpen: (id: string) => void;
}) {
  return <Table className="min-w-[1040px] table-fixed" aria-label="Agent review queue">
    <TableHeader className="bg-muted/50"><TableRow className="hover:bg-transparent">
      <TableHead className="w-[28%]">Agent</TableHead><TableHead className="w-[13%]">Location & scope</TableHead>
      <TableHead className="w-[15%]">KYC status</TableHead><TableHead className="w-[16%]">National ID</TableHead>
      <TableHead className="w-[18%]">Review timeline</TableHead><TableHead className="w-[10%]"><span className="sr-only">Dossier</span></TableHead>
    </TableRow></TableHeader>
    <TableBody>{rows.map((r) => <TableRow key={r.agent_id} data-state={selectedId === r.agent_id ? 'selected' : undefined}>
      <TableCell className="py-5"><div className="flex items-center gap-3">
        <Avatar className="h-12 w-12 border border-border"><AvatarImage src={photos?.[r.agent_id] ?? undefined} alt={`${r.name ?? 'Agent'} profile photo`} /><AvatarFallback className="text-sm font-semibold text-muted-foreground">{(r.name ?? 'A').split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('')}</AvatarFallback></Avatar>
        <div className="min-w-0"><Button variant="link" className="h-auto min-h-6 justify-start whitespace-normal p-0 text-left font-semibold text-foreground" onClick={() => onOpen(r.agent_id)}>{r.name ?? 'Unknown'}</Button><p className="mt-1 break-all text-xs text-muted-foreground">{r.phone ?? 'No phone on file'}</p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground" title={r.agent_id}>ID · {r.agent_id.slice(0, 8)}</p></div>
      </div></TableCell>
      <TableCell><p className="flex items-start gap-1.5 text-sm"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />{r.district ?? 'Not recorded'}</p><p className="mt-2 text-xs text-muted-foreground">{r.in_scope ? 'Active agent scope' : 'Outside active scope'}</p></TableCell>
      <TableCell><Badge variant="outline" className={`whitespace-normal ${r.status === 'verified' ? 'border-success/30 bg-success/10 text-success' : r.status === 'rejected' ? 'border-destructive/30 bg-destructive/10 text-destructive' : r.status === 'submitted' ? 'border-warning/30 bg-warning/10 text-warning' : 'text-muted-foreground'}`}>{VETTING_STATUS_LABEL[r.status] ?? 'Not started'}</Badge>
        {r.review_note && <p className="mt-2 line-clamp-2 text-xs text-muted-foreground" title={r.review_note}><MessageSquare className="mr-1 inline h-3 w-3" />{r.review_note}</p>}</TableCell>
      <TableCell><p className="text-sm">{r.id_source === 'parent' ? "Parent's ID" : r.id_source === 'own' ? 'Own ID' : 'Not on file'}</p><div className="mt-1">{links?.[r.agent_id] !== undefined ? links[r.agent_id] > 0 ? <Button variant="link" size="sm" className="h-auto min-h-6 gap-1 p-0 text-xs" onClick={() => onOpen(r.agent_id)} aria-label={`Review identity links for ${r.name ?? 'agent'}`}><Link2 className="h-3 w-3" />{links[r.agent_id]} linked agents</Button> : <span className="text-xs text-muted-foreground">No other agents linked</span> : <span className="text-xs text-muted-foreground">Links unavailable</span>}</div></TableCell>
      <TableCell><p className="text-xs" title={r.submitted_at ? stamp(r.submitted_at) : undefined}>{r.submitted_at ? `Submitted ${formatDistanceToNow(new Date(r.submitted_at), { addSuffix: true })}` : 'Not submitted'}</p><p className="mt-2 text-xs text-muted-foreground">{r.reviewed_at ? `Reviewed ${stamp(r.reviewed_at)}` : 'No recorded review'}</p></TableCell>
      <TableCell><Button variant="outline" size="icon" className="h-11 w-11" onClick={() => onOpen(r.agent_id)} aria-label={`Open review for ${r.name ?? 'agent'}`} title="Open agent dossier"><FileSearch className="h-4 w-4" /></Button></TableCell>
    </TableRow>)}</TableBody>
  </Table>;
}