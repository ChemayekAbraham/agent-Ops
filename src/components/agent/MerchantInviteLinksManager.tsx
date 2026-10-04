import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { hapticTap } from '@/lib/haptics';
import InviteMerchantAgentCard from './InviteMerchantAgentCard';
import MerchantLoginLinkCard from '@/components/cto/MerchantLoginLinkCard';
import { Copy, Share2, Plus, Link2, MousePointerClick, Loader2, Trash2, User } from 'lucide-react';

interface InviteLinkRow {
  id: string;
  code: string;
  target_params: Record<string, any>;
  created_at: string;
  click_count: number;
  last_clicked_at: string | null;
}

const TARGET_PATH = '/merchant/register';

export function MerchantInviteLinksManager() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [assigneeName, setAssigneeName] = useState('');
  const [assigneePhone, setAssigneePhone] = useState('');
  const [creating, setCreating] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const { data: links = [], isLoading } = useQuery({
    queryKey: ['merchant-invite-links', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('short_links')
        .select('id, code, target_params, created_at, click_count, last_clicked_at')
        .eq('user_id', user!.id)
        .eq('target_path', TARGET_PATH)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as InviteLinkRow[];
    },
  });

  const handleCreate = async () => {
    if (!user?.id) return;
    if (!label.trim() && !assigneeName.trim()) {
      toast({ title: 'Add a label or assignee', description: 'Give this link a name so you can tell links apart.', variant: 'destructive' });
      return;
    }
    hapticTap();
    setCreating(true);
    try {
      const params: Record<string, string> = { ref: user.id };
      if (label.trim()) params.label = label.trim();
      if (assigneeName.trim()) params.assignee = assigneeName.trim();
      if (assigneePhone.trim()) params.assignee_phone = assigneePhone.trim();

      const { error } = await supabase
        .from('short_links')
        .insert({ user_id: user.id, target_path: TARGET_PATH, target_params: params as any })
        .select('code')
        .single();
      if (error) throw error;

      setLabel('');
      setAssigneeName('');
      setAssigneePhone('');
      toast({ title: 'Invite link created' });
      qc.invalidateQueries({ queryKey: ['merchant-invite-links', user.id] });
    } catch (e: any) {
      const msg = e?.message?.includes('duplicate') || e?.code === '23505'
        ? 'A link with the same label already exists. Change the label or assignee.'
        : e?.message ?? 'Failed to create link';
      toast({ title: 'Could not create link', description: msg, variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async (url: string) => {
    hapticTap();
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Link copied' });
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  const handleShare = (url: string, tp: Record<string, any>) => {
    hapticTap();
    const who = tp.assignee ? ` for ${tp.assignee}` : '';
    const msg =
      `Join Welile as a Merchant Agent${who} and start earning commissions in your community.\n\n` +
      `Register using this link:\n${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this invite link? It will stop working immediately.')) return;
    const { error } = await supabase.from('short_links').delete().eq('id', id);
    if (error) {
      toast({ title: 'Delete failed', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: 'Link deleted' });
    qc.invalidateQueries({ queryKey: ['merchant-invite-links', user!.id] });
  };

  const totalClicks = useMemo(() => links.reduce((s, l) => s + (l.click_count || 0), 0), [links]);

  return (
    <div className="space-y-4">
      <InviteMerchantAgentCard />

      <MerchantLoginLinkCard />

      <Card className="p-4 rounded-2xl">
        <div className="flex items-center gap-2 mb-3">
          <Plus className="h-4 w-4 text-primary" />
          <h3 className="text-base font-bold">Generate a new invite link</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Create a unique link for each person you invite. The label helps you track who signed up from where.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Label</Label>
            <Input placeholder="e.g. Kampala market batch" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Assigned to (name)</Label>
            <Input placeholder="Full name" value={assigneeName} onChange={(e) => setAssigneeName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Assignee phone (optional)</Label>
            <Input placeholder="0700 000 000" value={assigneePhone} onChange={(e) => setAssigneePhone(e.target.value)} />
          </div>
        </div>
        <Button onClick={handleCreate} disabled={creating} className="mt-3 w-full md:w-auto">
          {creating ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
          Create link
        </Button>
      </Card>

      <Card className="p-4 rounded-2xl">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-primary" />
            <h3 className="text-base font-bold">Your invite links</h3>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{links.length} links</Badge>
            <Badge variant="secondary" className="gap-1"><MousePointerClick className="h-3 w-3" />{totalClicks} clicks</Badge>
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground text-center py-6">Loading…</p>
        ) : links.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No invite links yet. Create one above.</p>
        ) : (
          <ul className="divide-y">
            {links.map((l) => {
              const url = `${origin}/r/${l.code}`;
              const tp = l.target_params ?? {};
              const linkLabel = tp.label as string | undefined;
              const assignee = tp.assignee as string | undefined;
              const assigneePhoneVal = tp.assignee_phone as string | undefined;
              return (
                <li key={l.id} className="py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {linkLabel && <span className="text-sm font-semibold">{linkLabel}</span>}
                      {assignee && (
                        <Badge variant="outline" className="gap-1">
                          <User className="h-3 w-3" />{assignee}
                          {assigneePhoneVal ? ` · ${assigneePhoneVal}` : ''}
                        </Badge>
                      )}
                      {!linkLabel && !assignee && <span className="text-sm font-semibold text-muted-foreground">(unlabeled)</span>}
                    </div>
                    <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">{url}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {l.click_count} clicks · created {new Date(l.created_at).toLocaleDateString()}
                      {l.last_clicked_at ? ` · last click ${new Date(l.last_clicked_at).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button size="sm" variant="outline" onClick={() => handleCopy(url)}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" onClick={() => handleShare(url, tp)}>
                      <Share2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(l.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default MerchantInviteLinksManager;