import { useState, useEffect, useMemo, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  MessageSquare, Send, Loader2, Users, AlertTriangle, Eye, Smartphone,
  Home, UserCheck, Building2,
} from 'lucide-react';
import { toast } from 'sonner';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

const SMS_SEG = 160;
const SMS_MAX = 800;

type Audience = 'tenant' | 'agent' | 'landlord';

const AUDIENCE_META: { id: Audience; label: string; icon: typeof Home; desc: string }[] = [
  { id: 'tenant', label: 'Tenants', icon: Home, desc: 'Everyone with a tenant role' },
  { id: 'agent', label: 'Agents', icon: UserCheck, desc: 'Field & referral agents' },
  { id: 'landlord', label: 'Landlords', icon: Building2, desc: 'Registered landlords' },
];

// Default check-in message pre-filled in the composer; staff can edit before sending.
const DEFAULT_MESSAGE =
  'WELILE - Our Dear client hope you are doing well, we would like to know how you are finding our services if there is any thing you want us to help you with kindly contact us on +256748747134';

export function AudienceSMSBroadcast() {
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [testPhone, setTestPhone] = useState('');
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);

  const toggleAudience = (a: Audience) =>
    setAudiences((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]));

  const refreshCount = useCallback(async () => {
    if (audiences.length === 0) { setRecipientCount(0); return; }
    setLoadingCount(true);
    const { data } = await invokeEdgeFunction<{ recipient_count: number }>(
      'broadcast-audience-sms',
      { body: { dry_run: true, audiences }, silent: true },
    );
    if (data) setRecipientCount(data.recipient_count);
    setLoadingCount(false);
  }, [audiences]);

  useEffect(() => { refreshCount(); }, [refreshCount]);

  const segments = useMemo(() => Math.max(1, Math.ceil((message.length || 1) / SMS_SEG)), [message]);

  const handleSend = async () => {
    if (!message.trim()) { toast.error('Message body is empty'); return; }
    if (audiences.length === 0) { toast.error('Select at least one audience'); return; }
    setSending(true);
    const { data, error } = await invokeEdgeFunction<{ sent: number; failed: number; total: number }>(
      'broadcast-audience-sms',
      { body: { message: message.trim(), audiences }, errorTitle: 'SMS broadcast failed' },
    );
    setSending(false);
    setConfirmOpen(false);
    if (error || !data) return;
    toast.success(`Sent ${data.sent} SMS message${data.sent === 1 ? '' : 's'}`, {
      description: data.failed > 0
        ? `${data.failed} numbers failed at the gateway.`
        : `Delivered to ${data.total} recipient${data.total === 1 ? '' : 's'}.`,
    });
    setMessage(DEFAULT_MESSAGE);
  };

  const handleTest = async () => {
    if (!message.trim()) { toast.error('Message body is empty'); return; }
    if (!testPhone.trim()) { toast.error('Enter a test phone number'); return; }
    setTesting(true);
    const { data, error } = await invokeEdgeFunction<{ sent: number; failed: number }>(
      'broadcast-audience-sms',
      { body: { message: message.trim(), test_phone: testPhone.trim() }, errorTitle: 'Test SMS failed' },
    );
    setTesting(false);
    if (error || !data) return;
    if (data.sent > 0) toast.success(`Test SMS sent to ${testPhone}`);
    else toast.error('Test SMS not accepted by the gateway');
  };

  const previewBody = message.trim() || 'Your SMS preview will appear here. Keep it short and identify the sender.';
  const audienceReady = audiences.length > 0 && !loadingCount && (recipientCount ?? 0) > 0;

  return (
    <div className="space-y-4">
      {/* Hero */}
      <Card className="overflow-hidden border-0 bg-gradient-to-br from-violet-500 via-purple-600 to-fuchsia-600 text-white">
        <CardContent className="p-5 sm:p-6 flex items-start gap-4">
          <div className="h-12 w-12 rounded-2xl bg-white/15 backdrop-blur flex items-center justify-center shrink-0">
            <Send className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-[0.2em] opacity-80">Mass Communications</p>
            <h2 className="text-xl sm:text-2xl font-bold leading-tight">Message Tenants, Agents & Landlords</h2>
            <p className="text-sm opacity-90 mt-1">
              Draft one message and send it as branded SMS from <span className="font-semibold">WELILE</span> to whole audiences at once.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant="secondary" className="bg-white/15 hover:bg-white/15 text-white border-0">
                <Users className="h-3 w-3 mr-1" />
                {audiences.length === 0
                  ? 'Pick an audience'
                  : loadingCount ? 'Counting…' : `${(recipientCount ?? 0).toLocaleString()} recipients`}
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
        <Card className="lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" /> Choose audience
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {AUDIENCE_META.map((a) => {
                const active = audiences.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggleAudience(a.id)}
                    className={cn(
                      'flex items-start gap-2 rounded-xl border p-3 text-left transition-colors',
                      active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
                    )}
                  >
                    <Checkbox checked={active} className="mt-0.5 pointer-events-none" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-medium text-sm">
                        <a.icon className="h-3.5 w-3.5 text-primary" /> {a.label}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{a.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="aud-sms-body">Message</Label>
              <Textarea
                id="aud-sms-body"
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, SMS_MAX))}
                placeholder="Dear customer, … — WELILE"
                rows={6}
                className="resize-none font-mono text-sm leading-relaxed"
              />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 text-amber-600" />
                  No HTML. SMS is plain text only.
                </span>
                <span className={message.length > SMS_MAX ? 'text-destructive' : ''}>
                  {message.length}/{SMS_MAX} · {segments} segment{segments === 1 ? '' : 's'}
                </span>
              </div>
            </div>

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
                Send to {(recipientCount ?? 0).toLocaleString()} recipients
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Preview */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Eye className="h-4 w-4 text-primary" /> Live preview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mx-auto w-[280px] rounded-[2.5rem] border-[10px] border-slate-900 bg-slate-900 shadow-xl overflow-hidden">
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
              Recipients are de-duplicated by phone across selected audiences, so nobody gets the same SMS twice.
            </p>
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send SMS to selected audiences?</AlertDialogTitle>
            <AlertDialogDescription>
              This will send <b>{segments}</b> SMS segment{segments === 1 ? '' : 's'} to <b>{(recipientCount ?? 0).toLocaleString()}</b>{' '}
              recipient{(recipientCount ?? 0) === 1 ? '' : 's'} ({audiences.join(', ')}) via WELILE. This action is logged and cannot be recalled.
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

export default AudienceSMSBroadcast;
