import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { MessageSquare, Loader2, Save, RotateCcw, Send, History, CheckCircle2, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const CONFIG_KEY = 'momo_sender_signup_sms';

export interface MomoSignupSmsTemplate {
  enabled: boolean;
  thank_you_text: string;
  signup_prompt: string;
  signup_link: string;
  address: string;
  website: string;
  support_email: string;
}

const DEFAULTS: MomoSignupSmsTemplate = {
  enabled: true,
  thank_you_text: 'Thank you for sending {amount} via {provider}. Create your free Welile account to manage this money.',
  signup_prompt: 'Access your dashboard to view your wallet, transactions, and account details:',
  signup_link: 'https://welileapp.com/ZQhyGb',
  address: '',
  website: '',
  support_email: '',
};

interface TestSmsRecord {
  id: string;
  phone: string;
  formattedPhone?: string;
  message: string;
  at: string;
  ok: boolean;
  response: string;
}

/** Live preview of the exact SMS body the edge function assembles. */
export function buildPreview(t: MomoSignupSmsTemplate): string {
  const thankYou = (t.thank_you_text || '')
    .replace(/\{amount\}/gi, 'UGX 9,999')
    .replace(/\{provider\}/gi, 'MTN MoMo');
  return [
    `WELILE: ${thankYou}`.trim(),
    `${t.signup_prompt} ${t.signup_link}`.trim(),
    (t.address || '').trim(),
    [t.support_email, t.website].filter(Boolean).join(' | ').trim(),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Editor for the thank-you SMS sent to anyone who pays Welile via MTN/Airtel
 * Money. Stored in system_config so wording can change without a redeploy.
 */
export function MomoSignupSmsTemplatePanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tpl, setTpl] = useState<MomoSignupSmsTemplate>(DEFAULTS);
  const [testPhone, setTestPhone] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [history, setHistory] = useState<TestSmsRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('system_config')
        .select('value')
        .eq('key', CONFIG_KEY)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        toast.error('Could not load template', { description: error.message });
      } else if (data?.value) {
        const v = data.value as Partial<MomoSignupSmsTemplate>;
        setTpl({
          enabled: v.enabled !== false,
          thank_you_text: v.thank_you_text ?? DEFAULTS.thank_you_text,
          signup_prompt: v.signup_prompt ?? DEFAULTS.signup_prompt,
          signup_link: v.signup_link ?? DEFAULTS.signup_link,
          address: v.address ?? DEFAULTS.address,
          website: v.website ?? DEFAULTS.website,
          support_email: v.support_email ?? DEFAULTS.support_email,
        });
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const preview = useMemo(() => buildPreview(tpl), [tpl]);
  const segments = Math.max(1, Math.ceil(preview.length / 160));

  const set = <K extends keyof MomoSignupSmsTemplate>(key: K, value: MomoSignupSmsTemplate[K]) =>
    setTpl((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setSaving(true);
    const value = {
      enabled: tpl.enabled,
      thank_you_text: tpl.thank_you_text,
      signup_prompt: tpl.signup_prompt,
      signup_link: tpl.signup_link,
      address: tpl.address,
      website: tpl.website,
      support_email: tpl.support_email,
    };
    const { error } = await supabase
      .from('system_config')
      .update({ value, updated_at: new Date().toISOString() })
      .eq('key', CONFIG_KEY);
    setSaving(false);
    if (error) {
      toast.error('Save failed', { description: error.message });
    } else {
      toast.success('SMS template saved', { description: 'New senders will receive the updated message.' });
    }
  };

  const sendTest = async () => {
    const phone = testPhone.trim();
    if (!/\d{9,}/.test(phone.replace(/\D/g, ''))) {
      toast.error('Enter a valid phone number', { description: 'e.g. 0777123456 or +256777123456' });
      return;
    }
    setSendingTest(true);
    const messageSent = preview;
    try {
      const { data, error } = await supabase.functions.invoke('sms-test-send', {
        body: { phone, message: messageSent },
      });
      if (error) throw error;
      const ok = !!data?.ok;
      const response =
        data?.recipients?.[0]?.status ||
        data?.reason ||
        (typeof data?.raw === 'string' ? data.raw : JSON.stringify(data?.raw ?? data ?? {})) ||
        (ok ? 'Accepted by gateway' : 'Rejected by gateway');
      setHistory((prev) => [
        {
          id: crypto.randomUUID(),
          phone,
          formattedPhone: data?.formattedPhone,
          message: messageSent,
          at: new Date().toISOString(),
          ok,
          response: String(response),
        },
        ...prev,
      ].slice(0, 25));
      if (data?.ok) {
        toast.success('Test SMS sent', { description: `Delivered to ${data.formattedPhone ?? phone}. Check the phone.` });
      } else {
        toast.error('Test SMS not delivered', {
          description: data?.reason || data?.recipients?.[0]?.status || 'The SMS gateway rejected the message.',
        });
      }
    } catch (e) {
      setHistory((prev) => [
        {
          id: crypto.randomUUID(),
          phone,
          message: messageSent,
          at: new Date().toISOString(),
          ok: false,
          response: (e as Error).message,
        },
        ...prev,
      ].slice(0, 25));
      toast.error('Could not send test SMS', { description: (e as Error).message });
    } finally {
      setSendingTest(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading template…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <MessageSquare className="h-5 w-5 text-primary" />
            MoMo Thank-You SMS Template
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Sent automatically to anyone who pays Welile via MTN MoMo or Airtel Money, inviting them
            to open a free wallet. Edit the wording here — changes apply instantly, no redeploy needed.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label className="text-sm font-medium">Send these messages</Label>
              <p className="text-xs text-muted-foreground">Turn off to pause the thank-you SMS entirely.</p>
            </div>
            <Switch checked={tpl.enabled} onCheckedChange={(v) => set('enabled', v)} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="thank_you_text">Thank-you text</Label>
            <Textarea
              id="thank_you_text"
              value={tpl.thank_you_text}
              onChange={(e) => set('thank_you_text', e.target.value)}
              rows={2}
            />
            <p className="text-xs text-muted-foreground">
              Use <code>{'{amount}'}</code> and <code>{'{provider}'}</code> as placeholders — they are
              replaced with the real amount (e.g. UGX 9,999) and channel (MTN MoMo / Airtel Money).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="signup_prompt">Signup prompt</Label>
            <Input
              id="signup_prompt"
              value={tpl.signup_prompt}
              onChange={(e) => set('signup_prompt', e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="signup_link">Signup link</Label>
            <Input
              id="signup_link"
              value={tpl.signup_link}
              onChange={(e) => set('signup_link', e.target.value)}
              inputMode="url"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">Physical address</Label>
            <Textarea
              id="address"
              value={tpl.address}
              onChange={(e) => set('address', e.target.value)}
              rows={2}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="support_email">Support email</Label>
              <Input
                id="support_email"
                value={tpl.support_email}
                onChange={(e) => set('support_email', e.target.value)}
                inputMode="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                value={tpl.website}
                onChange={(e) => set('website', e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save template
            </Button>
            <Button variant="outline" onClick={() => setTpl(DEFAULTS)} disabled={saving}>
              <RotateCcw className="h-4 w-4" /> Reset to default
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Live preview</CardTitle>
          <p className="text-xs text-muted-foreground">
            Example with a UGX 9,999 MTN MoMo payment. {preview.length} characters · {segments} SMS
            {segments > 1 ? ' parts' : ' part'}.
          </p>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg bg-muted p-4 text-sm leading-relaxed whitespace-pre-wrap">
            {preview}
          </div>

          <div className="mt-4 space-y-2 rounded-lg border p-3">
            <Label htmlFor="test_phone" className="text-sm font-medium">
              Send test SMS
            </Label>
            <p className="text-xs text-muted-foreground">
              Sends this exact preview (with placeholders resolved) to a real phone so you can verify
              wording and the signup link.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="test_phone"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                placeholder="e.g. 0777123456"
                inputMode="tel"
                className="sm:max-w-xs"
              />
              <Button onClick={sendTest} disabled={sendingTest || !testPhone.trim()}>
                {sendingTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send test SMS
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="h-4 w-4 text-primary" />
              Test SMS history
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Most recent test sends this session — phone, the exact resolved message, time, and the
              gateway's response.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {history.map((h) => (
              <div key={h.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {h.ok ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive" />
                    )}
                    {h.formattedPhone || h.phone}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(h.at).toLocaleString()}
                  </span>
                </div>
                <div className="rounded-md bg-muted p-2 text-xs leading-relaxed whitespace-pre-wrap">
                  {h.message}
                </div>
                <p className="text-xs">
                  <span className="text-muted-foreground">Gateway response: </span>
                  <span className={h.ok ? 'text-green-600' : 'text-destructive'}>{h.response}</span>
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
