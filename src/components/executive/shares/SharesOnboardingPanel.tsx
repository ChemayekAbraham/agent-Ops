import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Download, Loader2, Plus, RefreshCw, Search, Send } from 'lucide-react';
import CreateShareholderDialog from './CreateShareholderDialog';
import ShareVettingDialog from './ShareVettingDialog';
import {
  SHARE_STATUS_LABEL, invokeShareFn, useShareRequests, type ShareRequestRow, type ShareStatus,
} from './useShareOnboarding';

const TABS: { key: string; label: string; statuses: ShareStatus[] }[] = [
  { key: 'pending', label: 'Awaiting signature', statuses: ['awaiting_signature'] },
  { key: 'vetting', label: 'Submitted / Vetting', statuses: ['submitted'] },
  { key: 'completed', label: 'Completed', statuses: ['completed'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
];

const variant = (s: ShareStatus) =>
  s === 'completed' ? 'default' : s === 'submitted' ? 'secondary' : s === 'cancelled' ? 'destructive' : 'outline';

export default function SharesOnboardingPanel() {
  const [tab, setTab] = useState('vetting');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [open, setOpen] = useState<ShareRequestRow | null>(null);
  const active = TABS.find((t) => t.key === tab)!;
  const { data: rows = [], isLoading, refetch, isFetching } = useShareRequests(active.statuses, search.trim());

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Shares Onboarding</h2>
          <p className="text-sm text-muted-foreground">Create Angel Pool shares, collect signatures and countersign agreements.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4" />Add new shareholder</Button>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search name, phone, email or reference" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button variant="outline" size="icon" onClick={() => refetch()} aria-label="Refresh">
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          {TABS.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t.key} value={t.key} className="mt-3">
            {isLoading ? (
              <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>
            ) : rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Nothing here yet.</p>
            ) : (
              <div className="grid gap-2">
                {rows.map((r) => <ShareRowCard key={r.id} row={r} onOpen={() => setOpen(r)} />)}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      <CreateShareholderDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ShareVettingDialog row={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function ShareRowCard({ row, onOpen }: { row: ShareRequestRow; onOpen: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const resend = async () => {
    setBusy(true);
    try {
      const res = await invokeShareFn('resend-share-onboarding-invite', { id: row.id });
      if (res.signing_url) await navigator.clipboard?.writeText(res.signing_url).catch(() => {});
      toast({ title: 'New signing link ready', description: res.emailed ? `Emailed to ${res.email} and copied.` : 'Link copied — share it with the shareholder.' });
    } catch (e: any) {
      toast({ title: 'Could not resend', description: e.message, variant: 'destructive' });
    } finally { setBusy(false); }
  };

  const download = async () => {
    const { data, error } = await supabase.storage.from('partner-agreements').createSignedUrl(row.pdf_path!, 600);
    if (error || !data) return toast({ title: 'Download failed', description: error?.message, variant: 'destructive' });
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
      <button type="button" onClick={onOpen} className="min-w-0 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{row.shareholder_full_name || 'Unnamed'}</span>
          <Badge variant={variant(row.status) as any}>{SHARE_STATUS_LABEL[row.status]}</Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {row.reference_id} • UGX {Number(row.amount).toLocaleString('en-US')} • {Number(row.shares).toLocaleString('en-US', { maximumFractionDigits: 2 })} shares
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {[row.shareholder_phone, row.shareholder_email].filter(Boolean).join(' • ')}
          {row.created_by_name ? ` • by ${row.created_by_name}` : ''}
        </p>
      </button>
      <div className="flex shrink-0 gap-2">
        {row.status === 'awaiting_signature' && (
          <Button size="sm" variant="outline" disabled={busy} onClick={resend}><Send className="mr-1.5 h-3.5 w-3.5" />Resend</Button>
        )}
        {row.status === 'completed' && row.pdf_path && (
          <Button size="sm" variant="outline" onClick={download}><Download className="mr-1.5 h-3.5 w-3.5" />PDF</Button>
        )}
        <Button size="sm" onClick={onOpen}>{row.status === 'submitted' ? 'Review' : 'Open'}</Button>
      </div>
    </div>
  );
}
