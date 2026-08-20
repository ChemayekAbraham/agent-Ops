import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Copy, Link2, Loader2, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { createShortLink } from '@/lib/createShortLink';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * Agent Ops → Service Centres: generate the request link an Ops officer sends to
 * an agent so the agent can set up a service centre. The link carries the setup
 * amount required, which the agent's service-centre page shows on arrival.
 */
export function ServiceCentreRequestLinkDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user } = useAuth();
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [generating, setGenerating] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const amountValue = Number(amount.replace(/[^\d]/g, '')) || 0;

  const message = link
    ? `Welile Service Centre request\n\nYou have been asked to set up a Welile service centre.\nSetup amount needed: ${formatUGX(amountValue)}${note.trim() ? `\n\nNote: ${note.trim()}` : ''}\n\nOpen this link to submit your service centre:\n${link}`
    : '';

  const handleGenerate = async () => {
    if (!user?.id) { toast.error('Sign in again to generate the link.'); return; }
    if (amountValue < 1000) { toast.error('Enter the setup amount needed (at least UGX 1,000).'); return; }
    setGenerating(true);
    try {
      const params: Record<string, string> = {
        sc: '1',
        setup_amount: String(amountValue),
      };
      if (note.trim()) params.sc_note = note.trim().slice(0, 160);
      const url = await createShortLink(user.id, '/agent-commission-benefits', params);
      setLink(url);
      toast.success('Request link generated.');
    } catch (e: any) {
      toast.error(e?.message || 'Could not generate the link.');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      toast.success('Request message copied.');
    } catch {
      toast.error('Copy failed — select the text manually.');
    }
  };

  const handleWhatsApp = () => {
    if (!message) return;
    const digits = phone.replace(/[^\d]/g, '');
    const target = digits ? `https://wa.me/${digits.replace(/^0/, '256')}?text=` : 'https://wa.me/?text=';
    window.open(`${target}${encodeURIComponent(message)}`, '_blank', 'noopener');
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setLink(null); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Link2 className="h-4 w-4 text-primary" />
            Service centre request link
          </DialogTitle>
          <DialogDescription>
            Set the amount the agent needs to set up the centre, then send the link.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sc-amount">Setup amount needed (UGX)</Label>
            <Input
              id="sc-amount"
              inputMode="numeric"
              placeholder="e.g. 250000"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setLink(null); }}
            />
            {amountValue > 0 && (
              <p className="text-xs text-muted-foreground">{formatUGX(amountValue)}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sc-phone">Agent phone (optional — for WhatsApp)</Label>
            <Input
              id="sc-phone"
              inputMode="tel"
              placeholder="07XXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sc-note">Note to the agent (optional)</Label>
            <Textarea
              id="sc-note"
              rows={3}
              placeholder="Where the centre should be, what to buy, deadline…"
              value={note}
              onChange={(e) => { setNote(e.target.value); setLink(null); }}
            />
          </div>

          {link && (
            <div className="rounded-xl border border-border bg-muted/40 p-3 space-y-2">
              <p className="text-xs font-semibold">Request link</p>
              <p className="text-xs break-all font-mono">{link}</p>
              <p className="text-xs text-muted-foreground whitespace-pre-line">{message}</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleGenerate} disabled={generating} className="gap-2">
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {link ? 'Regenerate link' : 'Generate link'}
            </Button>
            <Button variant="outline" onClick={handleCopy} disabled={!link} className="gap-2">
              <Copy className="h-4 w-4" />Copy
            </Button>
            <Button variant="outline" onClick={handleWhatsApp} disabled={!link} className="gap-2">
              <MessageCircle className="h-4 w-4" />WhatsApp
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
