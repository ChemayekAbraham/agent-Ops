import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  MessageSquare, Send, Sparkles, Loader2, Users, AlertTriangle, Eye, Smartphone,
} from 'lucide-react';
import { toast } from 'sonner';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const SMS_SEG = 160;
const SMS_MAX = 800; // 5 segments
const TEMPLATES: Array<{ label: string; body: string }> = [
  { label: 'Welcome', body: 'Hello {name}, thanks for partnering with Welile. Your portfolio is active and earning. Reply HELP for support.' },
  { label: 'Returns ready', body: 'Hi {name}, your monthly returns from Welile are ready in your wallet. Open the app to withdraw. Thank you.' },
  { label: 'New opportunity', body: 'Hi {name}, a new Welile portfolio is open for top-up at solid returns. Open the app to view. Reply STOP to opt out.' },
  {
    label: 'Weekend payments notice',
    body: `Dear Valued Partner,

Greetings from Welile.

Please note that return payments are not processed on weekends (Saturday and Sunday). Any payments due during this period will be processed on the next working day (Monday). This helps us ensure accuracy and smooth handling of all transactions.

*Please note that even on public holidays*

*For any inquiries* or assistance, please contact our Customer Care team on:

+256748747134

+256793750331

Thank you for your understanding and continued support.

*Kind regards,*

Gloria

Customer Care Manager

Welile technologies limited`,
  },
];

export function PartnerSMSBroadcast() {
  const [message, setMessage] = useState(
    TEMPLATES.find((t) => t.label === 'Weekend payments notice')?.body ?? '',
  );
  const [testPhone, setTestPhone] = useState('');
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await invokeEdgeFunction<{ recipient_count: number }>(
        'cto-broadcast-partners-sms',
        { body: { dry_run: true }, silent: true },
      );
      if (cancelled) return;
      if (data) setRecipientCount(data.recipient_count);
      setLoadingCount(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const segments = useMemo(() => Math.max(1, Math.ceil((message.length || 1) / SMS_SEG)), [message]);
  const remaining = SMS_MAX - message.length;

  const handleSend = async () => {
    if (!message.trim()) { toast.error('Message body is empty'); return; }
    setSending(true);
    const { data, error } = await invokeEdgeFunction<{ sent: number; failed: number; total: number }>(
      'cto-broadcast-partners-sms',
      { body: { message: message.trim() }, errorTitle: 'SMS broadcast failed' },
    );
    setSending(false);
    setConfirmOpen(false);
    if (error || !data) return;
    toast.success(`Sent ${data.sent} SMS message${data.sent === 1 ? '' : 's'}`, {
      description: data.failed > 0
        ? `${data.failed} numbers failed at the gateway.`
        : `Delivered to ${data.total} partner${data.total === 1 ? '' : 's'}.`,
    });
    setMessage('');
  };

  const handleTest = async () => {
    if (!message.trim()) { toast.error('Message body is empty'); return; }
    if (!testPhone.trim()) { toast.error('Enter a test phone number'); return; }
    setTesting(true);
    const { data, error } = await invokeEdgeFunction<{ sent: number; failed: number }>(
      'cto-broadcast-partners-sms',
      { body: { message: message.trim(), test_phone: testPhone.trim() }, errorTitle: 'Test SMS failed' },
    );
    setTesting(false);
    if (error || !data) return;
    if (data.sent > 0) toast.success(`Test SMS sent to ${testPhone}`);
    else toast.error('Test SMS not accepted by the gateway');
  };

  const previewBody = message.trim() || 'Your SMS preview will appear here. Keep it short, identify the sender, and avoid links unless you mean it.';
  const audienceReady = !loadingCount && (recipientCount ?? 0) > 0;

  return (
    <div className="space-y-4">
      {/* Hero */}
      <Card className="overflow-hidden border-0 bg-gradient-to-br from-violet-500 via-purple-600 to-fuchsia-600 text-white">
        <CardContent className="p-5 sm:p-6 flex items-start gap-4">
          <div className="h-12 w-12 rounded-2xl bg-white/15 backdrop-blur flex items-center justify-center shrink-0">
            <Sparkles className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-[0.2em] opacity-80">Partner Communications</p>
            <h2 className="text-xl sm:text-2xl font-bold leading-tight">Mass SMS to Partners</h2>
            <p className="text-sm opacity-90 mt-1">
              Send a short, branded text from <span className="font-semibold">WELILE</span> to every partner with a phone on file.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant="secondary" className="bg-white/15 hover:bg-white/15 text-white border-0">
                <Users className="h-3 w-3 mr-1" />
                {loadingCount ? 'Counting…' : `${recipientCount ?? 0} partners reachable by SMS`}
              </Badge>
              <Badge variant="secondary" className="bg-white/15 hover:bg-white/15 text-white border-0">
                <MessageSquare className="h-3 w-3 mr-1" />
                {segments} SMS segment{segments === 1 ? '' : 's'}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Composer */}
        <Card className="lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" /> Compose SMS
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Templates */}
            <div className="flex flex-wrap gap-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => setMessage(t.body)}
                  className="text-[11px] px-2.5 py-1 rounded-full border bg-muted/40 hover:bg-muted transition-colors"
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sms-body">Message</Label>
              <Textarea
                id="sms-body"
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, SMS_MAX))}
                placeholder="Hi {name}, your monthly returns are ready in your wallet. — WELILE"
                rows={6}
                className="resize-none font-mono text-sm leading-relaxed"
              />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 text-amber-600" />
                  No HTML. SMS is plain text only.
                </span>
                <span className={remaining < 0 ? 'text-destructive' : ''}>
                  {message.length}/{SMS_MAX} · {segments} segment{segments === 1 ? '' : 's'}
                </span>
              </div>
            </div>

            {/* Test send */}
            <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Send a test first</Label>
              <div className="flex gap-2">
                <Input
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  placeholder="0712345678"
                  className="h-9"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={testing || !message.trim() || !testPhone.trim()}
                >
                  {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />}
                  <span className="ml-1">Test</span>
                </Button>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
              <p className="text-xs text-muted-foreground">
                Sender ID: <span className="font-mono font-semibold">WELILE</span> · billed per segment per recipient.
              </p>
              <Button
                size="lg"
                disabled={sending || !message.trim() || !audienceReady}
                onClick={() => setConfirmOpen(true)}
                className="bg-gradient-to-r from-violet-500 to-fuchsia-600 hover:opacity-90"
              >
                {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                Send to {recipientCount ?? 0} partners
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Phone preview */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Eye className="h-4 w-4 text-primary" /> Live preview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mx-auto w-[280px] rounded-[2.5rem] border-[10px] border-slate-900 bg-slate-900 shadow-xl overflow-hidden">
              {/* notch */}
              <div className="h-5 bg-slate-900 flex items-center justify-center">
                <div className="h-1.5 w-16 rounded-full bg-slate-700" />
              </div>
              <div className="bg-gradient-to-b from-slate-100 to-slate-50 min-h-[420px] px-3 py-3">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground font-medium px-1 mb-3">
                  <span>9:41</span>
                  <span>WELILE</span>
                  <span>5G</span>
                </div>
                <div className="text-center text-[10px] text-muted-foreground mb-2">Today, just now</div>
                <div className="flex items-start gap-2">
                  <div className="h-8 w-8 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                    W
                  </div>
                  <div className="max-w-[210px] rounded-2xl rounded-tl-sm bg-card border border-border px-3 py-2 shadow-sm">
                    <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1 font-semibold">WELILE</div>
                    <p className="text-[12.5px] leading-snug text-foreground whitespace-pre-wrap break-words">
                      {previewBody}
                    </p>
                    <div className="text-[9px] text-muted-foreground mt-1 text-right">{segments} SMS</div>
                  </div>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground text-center mt-3">
              Each partner sees this on their phone. Replace <code className="text-[10px] bg-muted px-1 py-0.5 rounded">{'{name}'}</code> with the partner's first name later via personalisation.
            </p>
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send SMS to all partners?</AlertDialogTitle>
            <AlertDialogDescription>
              This will send <b>{segments}</b> SMS segment{segments === 1 ? '' : 's'} to <b>{recipientCount ?? 0}</b> partner phone{(recipientCount ?? 0) === 1 ? '' : 's'} via Yoola. This action is logged and cannot be recalled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSend} disabled={sending}>
              {sending ? 'Sending…' : 'Confirm & Send'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default PartnerSMSBroadcast;