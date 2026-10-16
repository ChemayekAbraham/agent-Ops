import { useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, FilePlus2, History, Megaphone, Pencil, RefreshCw, Save, Send, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCrmCommunicationManager, useManageCommunication } from '@/hooks/useCrmCommunications';
import { communicationAudiences, communicationDestinations, communicationTime, communicationTypes, kampalaInput, kampalaInputToIso, validateCommunication, type Communication, type CommunicationContent, type CommunicationType } from '@/lib/crmCommunications';
import { CommunicationDialog, communicationIcons } from './CommunicationDialog';

function freshContent(): CommunicationContent {
  return { id: crypto.randomUUID(), revision_id: crypto.randomUUID(), title: '', body: '', communication_type: 'announcement', audiences: [], link_path: '', starts_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), confirm_everyone: false };
}
const statuses = ['all', 'draft', 'scheduled', 'live', 'ended', 'withdrawn'];
export default function CommunicationManager() {
  const [status, setStatus] = useState('all');
  const [offset, setOffset] = useState(0);
  const query = useCrmCommunicationManager(status, offset);
  const mutation = useManageCommunication();
  const [editor, setEditor] = useState(false);
  const [selected, setSelected] = useState<Communication | null>(null);
  const [content, setContent] = useState<CommunicationContent>(freshContent);
  const [start, setStart] = useState(() => kampalaInput(new Date()));
  const [end, setEnd] = useState(() => kampalaInput(new Date(Date.now() + 7 * 86400000)));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Communication | null>(null);
  const [withdraw, setWithdraw] = useState<Communication | null>(null);
  const [history, setHistory] = useState<Communication | null>(null);
  const [notice, setNotice] = useState('');
  const change = <K extends keyof CommunicationContent>(key: K, value: CommunicationContent[K]) => setContent(old => ({ ...old, [key]: value }));
  function openEditor(row?: Communication) {
    const next = freshContent();
    if (row) Object.assign(next, { title: row.title, body: row.body, communication_type: row.communication_type, audiences: row.audiences ?? [], link_path: row.link_path ?? '', starts_at: row.starts_at, expires_at: row.expires_at });
    setContent(next); setSelected(row ?? null); setStart(kampalaInput(next.starts_at)); setEnd(kampalaInput(next.expires_at));
    setReason(''); setError(null); mutation.reset(); setEditor(true);
  }
  function validated(): CommunicationContent | null {
    try {
      const next = { ...content, starts_at: kampalaInputToIso(start), expires_at: kampalaInputToIso(end) };
      const issue = validateCommunication(next);
      if (issue) throw new Error(issue);
      setError(null); return next;
    } catch (e) { setError(e instanceof Error ? e.message : 'Check your communication details.'); return null; }
  }
  async function save(action: 'save' | 'publish') {
    const next = validated(); if (!next) return;
    if (reason.trim().length < 10) { setError('Enter a reason of at least 10 characters.'); return; }
    if (action === 'publish' && next.audiences.includes('everyone') && !next.confirm_everyone) { setError('Confirm this communication is for Everyone before publishing.'); return; }
    try {
      const result = await mutation.mutateAsync({ action, id: selected?.id ?? null, content: next, reason });
      setEditor(false); setSelected(null);
      setNotice(action === 'save' ? 'Draft saved.' : new Date(result.starts_at) > new Date() ? 'Communication scheduled.' : 'Communication published.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save. Please retry.'); }
  }
  async function confirmWithdraw() {
    if (!withdraw) return;
    if (reason.trim().length < 10) { setError('Enter a reason of at least 10 characters.'); return; }
    try { await mutation.mutateAsync({ action: 'withdraw', id: withdraw.id, reason }); setWithdraw(null); setNotice('Communication withdrawn.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to withdraw.'); }
  }
  const previewContent = () => { const next = validated(); if (next) setPreview({ ...next, series_id: selected?.series_id ?? next.id, version: selected?.version ?? 1 }); };
  return <section className="space-y-6 min-w-0">
    <header className="flex items-center justify-between gap-3 flex-wrap border-b border-border pb-5">
      <div className="flex items-center gap-3"><Megaphone className="h-6 w-6 text-primary" /><h1 className="text-2xl font-semibold">Broadcast</h1></div>
      <Button onClick={() => openEditor()}><FilePlus2 className="mr-2 h-4 w-4" />New communication</Button>
    </header>
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    {editor ? <form className="max-w-3xl space-y-5" onSubmit={e => { e.preventDefault(); void save('save'); }}>
      <div className="flex justify-between items-center gap-2"><h2 className="text-lg font-semibold">{selected?.state === 'published' ? 'New published version' : selected ? 'Edit draft' : 'New communication'}</h2><Button type="button" variant="ghost" onClick={() => setEditor(false)} disabled={mutation.isPending}>Cancel</Button></div>
      <fieldset className="space-y-3"><legend className="font-medium text-sm mb-3">Audience</legend>
        <div className="flex gap-x-6 gap-y-3 flex-wrap">{communicationAudiences.map(a => <Label key={a.value} className="flex items-center gap-2 cursor-pointer"><Checkbox checked={content.audiences.includes(a.value)} onCheckedChange={checked => {
          const audiences = a.value === 'everyone' ? checked ? ['everyone'] : [] : checked ? [...content.audiences.filter(x => x !== 'everyone'), a.value] : content.audiences.filter(x => x !== a.value);
          setContent(old => ({ ...old, audiences, confirm_everyone: false }));
        }} />{a.label}</Label>)}</div>
      </fieldset>
      <div className="space-y-2"><Label htmlFor="communication-type">Type</Label><Select value={content.communication_type} onValueChange={v => change('communication_type', v as CommunicationType)}><SelectTrigger id="communication-type"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(communicationTypes).map(([value, item]) => <SelectItem key={value} value={value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-2"><Label htmlFor="communication-title">Title</Label><Input id="communication-title" maxLength={160} value={content.title} onChange={e => change('title', e.target.value)} required /></div>
      <div className="space-y-2"><Label htmlFor="communication-body">Message</Label><Textarea id="communication-body" rows={7} maxLength={8000} value={content.body} onChange={e => change('body', e.target.value)} required /><p className="text-xs text-muted-foreground text-right">{content.body.length.toLocaleString()} / 8,000</p></div>
      <div className="space-y-2"><Label htmlFor="communication-destination">Destination</Label><Select value={content.link_path || 'none'} onValueChange={v => change('link_path', v === 'none' ? '' : v)}><SelectTrigger id="communication-destination"><SelectValue /></SelectTrigger><SelectContent>{communicationDestinations.map(d => <SelectItem key={d.value} value={d.value || 'none'}>{d.label}</SelectItem>)}</SelectContent></Select></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><div className="space-y-2"><Label htmlFor="communication-start">Starts · Kampala time</Label><Input type="datetime-local" id="communication-start" value={start} onChange={e => setStart(e.target.value)} required /></div><div className="space-y-2"><Label htmlFor="communication-end">Expires · Kampala time</Label><Input type="datetime-local" id="communication-end" value={end} onChange={e => setEnd(e.target.value)} required /></div></div>
      <div className="space-y-2"><Label htmlFor="communication-reason">Reason for this change</Label><Textarea id="communication-reason" rows={2} value={reason} minLength={10} maxLength={1000} onChange={e => setReason(e.target.value)} required /></div>
      {content.audiences.includes('everyone') && <Label className="flex gap-3 items-start"><Checkbox checked={content.confirm_everyone} onCheckedChange={v => change('confirm_everyone', v === true)} />I confirm this message is for Everyone, including staff.</Label>}
      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <div className="flex flex-wrap gap-2 border-t border-border pt-5"><Button type="button" variant="outline" onClick={previewContent}><Eye className="h-4 w-4 mr-2" />Preview dialog</Button><Button type="submit" variant="secondary" disabled={mutation.isPending}><Save className="h-4 w-4 mr-2" />Save draft</Button><Button type="button" onClick={() => void save('publish')} disabled={mutation.isPending}><Send className="h-4 w-4 mr-2" />{mutation.isPending ? 'Saving…' : 'Publish / Schedule'}</Button></div>
    </form> : <>
      <div className="flex items-center justify-between gap-3"><div className="w-44"><Select value={status} onValueChange={v => { setStatus(v); setOffset(0); }}><SelectTrigger aria-label="Communication status"><SelectValue /></SelectTrigger><SelectContent>{statuses.map(s => <SelectItem key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</SelectItem>)}</SelectContent></Select></div><Button variant="ghost" size="icon" aria-label="Refresh communications" title="Refresh communications" onClick={() => void query.refetch()}><RefreshCw className="h-4 w-4" /></Button></div>
      {query.isLoading && <p role="status" className="text-muted-foreground">Loading communications…</p>}
      {query.error && <p role="alert" className="text-destructive">{query.error.message}</p>}
      {!query.isLoading && !query.error && !query.data?.items.length && <div className="py-12 text-center text-muted-foreground"><Megaphone className="h-8 w-8 mx-auto mb-3" /><p>No {status === 'all' ? '' : status + ' '}communications.</p></div>}
      <div className="divide-y divide-border">{query.data?.items.map(row => {
        const Icon = communicationIcons[row.communication_type];
        return <article key={row.id} className="py-5 space-y-3">
          <div className="flex items-start gap-3"><Icon className="text-primary h-5 w-5 shrink-0 mt-1" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2 flex-wrap"><h2 className="font-semibold break-words">{row.title}</h2><Badge variant="secondary">{row.status}</Badge><span className="text-xs text-muted-foreground">v{row.version}</span></div><p className="text-sm text-muted-foreground mt-1">{row.audiences?.map(v => communicationAudiences.find(a => a.value === v)?.label ?? v).join(', ')} · {row.author_name || 'CRM'}</p></div></div>
          <p className="text-sm text-muted-foreground">{communicationTime(row.starts_at)} — {communicationTime(row.expires_at)} · Kampala</p>
          <div className="flex justify-between items-center gap-3 flex-wrap"><span className="text-sm text-muted-foreground">{Number(row.acknowledgements ?? 0).toLocaleString()} acknowledged</span><div className="flex gap-1 flex-wrap"><Button variant="ghost" size="sm" onClick={() => setPreview(row)}><Eye className="h-4 w-4 mr-1" />Preview</Button><Button variant="ghost" size="sm" onClick={() => openEditor(row)}><Pencil className="h-4 w-4 mr-1" />{row.state === 'draft' ? 'Edit' : 'New version'}</Button><Button variant="ghost" size="icon" title="Change history" aria-label={`History for ${row.title}`} onClick={() => setHistory(row)}><History className="h-4 w-4" /></Button>{row.state !== 'withdrawn' && <Button variant="ghost" size="sm" onClick={() => { setWithdraw(row); setReason(''); setError(null); }}><XCircle className="h-4 w-4 mr-1" />Withdraw</Button>}</div></div>
        </article>;
      })}</div>
      {Number(query.data?.total ?? 0) > 20 && <div className="flex justify-between items-center border-t border-border pt-4"><Button variant="outline" size="icon" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(v => Math.max(0, v - 20))}><ChevronLeft /></Button><span className="text-sm">{offset + 1}–{Math.min(offset + 20, query.data?.total ?? 0)} of {query.data?.total}</span><Button variant="outline" size="icon" aria-label="Next page" disabled={offset + 20 >= (query.data?.total ?? 0)} onClick={() => setOffset(v => v + 20)}><ChevronRight /></Button></div>}
    </>}
    <CommunicationDialog communication={preview} open={!!preview} preview onClose={() => setPreview(null)} />
    <Dialog open={!!withdraw} onOpenChange={v => { if (!v && !mutation.isPending) setWithdraw(null); }}><DialogContent stable className="w-[calc(100%-2rem)] rounded-lg"><DialogHeader><DialogTitle className="pr-10 leading-snug tracking-normal">Withdraw communication</DialogTitle><DialogDescription>{withdraw?.title}</DialogDescription></DialogHeader><Label htmlFor="withdraw-reason">Reason</Label><Textarea id="withdraw-reason" value={reason} onChange={e => setReason(e.target.value)} minLength={10} maxLength={1000} />{error && <p role="alert" className="text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setWithdraw(null)} disabled={mutation.isPending}>Cancel</Button><Button variant="destructive" onClick={() => void confirmWithdraw()} disabled={mutation.isPending}>Withdraw</Button></div></DialogContent></Dialog>
    <Dialog open={!!history} onOpenChange={v => { if (!v) setHistory(null); }}><DialogContent stable className="w-[calc(100%-2rem)] rounded-lg"><DialogHeader><DialogTitle className="pr-10 leading-snug tracking-normal">Communication history</DialogTitle><DialogDescription>{history?.title} · Version {history?.version}</DialogDescription></DialogHeader><div className="divide-y divide-border">{history?.history?.map(e => <div key={e.id} className="py-3 space-y-1"><p className="font-medium capitalize">{e.action}</p><p className="text-sm break-words">{e.reason}</p><p className="text-xs text-muted-foreground">{communicationTime(e.created_at)} · Kampala</p></div>)}</div></DialogContent></Dialog>
  </section>;
}
