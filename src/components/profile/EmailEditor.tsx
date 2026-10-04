import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Mail, Loader2, Save } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { z } from 'zod';

interface Props {
  /** Self-edit mode: user updates their own email (triggers auth.updateUser).
   *  Agent mode: agent updates the profile email field of a managed user (no auth email change).
   */
  mode: 'self' | 'agent';
  userId: string;
  currentEmail: string;
  onSaved?: (newEmail: string) => void;
}

const EmailSchema = z.string().trim().email().max(255);

export default function EmailEditor({ mode, userId, currentEmail, onSaved }: Props) {
  const [email, setEmail] = useState(currentEmail);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const parsed = EmailSchema.safeParse(email);
    if (!parsed.success) { toast.error('Enter a valid email address'); return; }
    if (parsed.data === currentEmail) { toast.info('Email unchanged'); return; }
    setSaving(true);

    if (mode === 'self') {
      // Update auth (sends confirmation), then update profile
      const { error: authErr } = await supabase.auth.updateUser({ email: parsed.data });
      if (authErr) { toast.error(authErr.message); setSaving(false); return; }
      const { error: profErr } = await supabase.from('profiles').update({ email: parsed.data }).eq('id', userId);
      if (profErr) { toast.error('Email auth updated, profile sync failed: ' + profErr.message); setSaving(false); return; }
      toast.success('Verification email sent. Confirm to complete the change.');
    } else {
      // Agent updating dormant user's profile email only
      const { error } = await supabase.from('profiles').update({ email: parsed.data }).eq('id', userId);
      if (error) { toast.error('Failed: ' + error.message); setSaving(false); return; }
      const { data: { user: actor } } = await supabase.auth.getUser();
      if (actor) {
        await supabase.from('agent_managed_user_actions').insert({
          agent_id: actor.id, user_id: userId, action_type: 'email_updated',
          details: { from: currentEmail, to: parsed.data },
        });
      }
      toast.success('Email updated');
    }
    onSaved?.(parsed.data);
    setSaving(false);
  };

  return (
    <Card className="border-border/40 rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><Mail className="h-4 w-4 text-primary" /> Email Address</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Email</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" className="h-11 rounded-xl" />
          {mode === 'self' && (
            <p className="text-[11px] text-muted-foreground">A confirmation link will be sent to the new address.</p>
          )}
        </div>
        <Button onClick={save} disabled={saving || !email.trim()} className="w-full gap-2 h-11 rounded-xl text-sm font-bold">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Email
        </Button>
      </CardContent>
    </Card>
  );
}
