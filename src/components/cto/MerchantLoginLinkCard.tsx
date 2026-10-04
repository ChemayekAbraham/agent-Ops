import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { hapticTap } from '@/lib/haptics';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { Copy, LogIn, Share2 } from 'lucide-react';

const MERCHANT_DASHBOARD_PATH = '/dashboard/agent';

/**
 * CTO tool: generate the secure Merchant Login deep link.
 *
 * The link always opens the Merchant Login screen (never the welcome screen,
 * landing page, sign-up or role selection) and carries the intended
 * destination in `redirect`. Merchant privileges are re-verified from the
 * database after authentication, so the query param alone grants nothing.
 */
export default function MerchantLoginLinkCard() {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const origin = getPublicOrigin();

  const url = useMemo(
    () => `${origin}/merchant/login?redirect=${encodeURIComponent(MERCHANT_DASHBOARD_PATH)}`,
    [origin],
  );

  const copy = async () => {
    hapticTap();
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Merchant login link copied' });
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  const share = () => {
    hapticTap();
    const who = name.trim() ? `${name.trim()}, ` : '';
    const msg =
      `${who}sign in to your Welile Merchant Agent dashboard here:\n${url}\n\n` +
      `Use the phone number or email registered for your merchant account.`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };

  return (
    <Card className="p-4 rounded-2xl space-y-3">
      <div className="flex items-center gap-2">
        <LogIn className="h-4 w-4 text-primary" />
        <h3 className="text-base font-bold">Merchant login link</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        For merchants who already have an account. Opens the Merchant Login screen directly and, once
        signed in and verified as an active merchant, lands on the Merchant Dashboard.
      </p>
      <p className="text-xs font-mono bg-muted rounded-lg p-2 break-all">{url}</p>
      <div className="space-y-1">
        <Label className="text-xs">Merchant name (optional, for the WhatsApp message)</Label>
        <Input placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={copy} className="flex-1">
          <Copy className="h-4 w-4 mr-1.5" /> Copy link
        </Button>
        <Button onClick={share} className="flex-1">
          <Share2 className="h-4 w-4 mr-1.5" /> Share
        </Button>
      </div>
    </Card>
  );
}