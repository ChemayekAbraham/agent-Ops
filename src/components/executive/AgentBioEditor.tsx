import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { AgentAvatar } from './AgentAvatar';
import { toast } from 'sonner';
import { Loader2, Pencil, Save, X, ShieldCheck } from 'lucide-react';

const EDITABLE: { key: string; label: string; placeholder?: string }[] = [
  { key: 'full_name', label: 'Full name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'national_id', label: 'National ID' },
  { key: 'mobile_money_number', label: 'Mobile money number' },
  { key: 'mobile_money_name', label: 'Mobile money name' },
  { key: 'mobile_money_provider', label: 'Mobile money provider', placeholder: 'MTN / Airtel' },
  { key: 'occupation', label: 'Occupation' },
  { key: 'region', label: 'Region' },
  { key: 'district', label: 'District' },
  { key: 'sub_county', label: 'Sub-county' },
  { key: 'village', label: 'Village' },
  { key: 'territory', label: 'Territory' },
];

const dt = (v?: string | null) => (v ? new Date(v).toLocaleDateString() : '—');

interface Props {
  agentId: string | null;
  bio: any;
}

export function AgentBioEditor({ agentId, bio }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const f of EDITABLE) next[f.key] = bio?.[f.key] ? String(bio[f.key]) : '';
    setForm(next);
    setEditing(false);
  }, [agentId, bio]);

  const save = async () => {
    if (!agentId) return;
    if (!form.full_name?.trim()) { toast.error('Full name is required'); return; }
    setSaving(true);
    try {
      const { error } = await supabase.rpc('ops_update_agent_profile' as any, {
        p_agent_id: agentId,
        p_updates: form as any,
      });
      if (error) throw error;
      toast.success('Profile updated');
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ['agent-profile-360', agentId] });
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-2xl border border-border bg-background p-3">
        <AgentAvatar src={bio?.avatar_url} name={bio?.full_name} className="h-16 w-16" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-sm truncate">{bio?.full_name || 'Unknown'}</span>
            {bio?.verified && <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />}
            <Badge variant={bio?.agent_kind === 'sub_agent' ? 'secondary' : 'default'} className="text-[10px]">
              {bio?.agent_kind === 'sub_agent' ? 'Sub-Agent' : 'Agent'}
            </Badge>
            {bio?.is_frozen && <Badge variant="destructive" className="text-[10px]">Frozen</Badge>}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            Joined {dt(bio?.created_at)} · Last active {dt(bio?.last_active_at)} · Tier {bio?.agent_tier || '—'}
          </p>
          {bio?.parent_agent && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Recruited by <strong className="text-foreground">{bio.parent_agent.full_name}</strong>
              {bio.parent_agent.phone ? ` · ${bio.parent_agent.phone}` : ''}
            </p>
          )}
        </div>
        {!editing ? (
          <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
        ) : (
          <div className="flex gap-1.5 shrink-0">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              <X className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" className="gap-1.5" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
            </Button>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-border bg-background p-3">
        <p className="text-xs font-semibold mb-2">Bio data</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
          {EDITABLE.map(f => (
            <div key={f.key} className="min-w-0 space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">{f.label}</Label>
              {editing ? (
                <Input
                  value={form[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  className="h-9 text-xs"
                />
              ) : (
                <p className="text-xs font-medium break-words">{form[f.key] || '—'}</p>
              )}
            </div>
          ))}
          <div className="min-w-0 space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Verified</Label>
            <p className="text-xs font-medium">{bio?.verified ? 'Yes' : 'No'}</p>
          </div>
          <div className="min-w-0 space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Frozen</Label>
            <p className="text-xs font-medium break-words">
              {bio?.is_frozen ? `Yes — ${bio?.frozen_reason || 'no reason given'}` : 'No'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
