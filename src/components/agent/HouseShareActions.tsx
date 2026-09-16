import { useState } from 'react';
import { Check, Copy, FileText, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { PromissoryNoteDialog } from '@/components/agent/PromissoryNoteDialog';
import { houseTitleLine, houseAddressLine, type SupportableHouse } from '@/components/partner/SelfSupportHousesSection';
import { createHouseShareLink, houseShareMessage } from '@/lib/houseSupportShare';

const houseSummary = (house: SupportableHouse) => ({
  title: houseTitleLine(house),
  place: houseAddressLine(house),
  monthly_rent: Number(house.monthly_rent || 0),
});

/**
 * Share actions for one empty house.
 *
 * The primary action opens the self-support promissory note dialog so the agent
 * creates the note and shares its activation link from there. The WhatsApp and
 * copy buttons keep the original house share logic: the opaque,
 * attribution-carrying support deep link created by
 * `get_or_create_house_share_link` — welileapp.com/s/<code> — so whoever opens
 * it lands on the public support page and this agent stays credited server-side.
 */
export function HouseShareActions({ house }: { house: SupportableHouse }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const build = async () => {
    const { share_url } = await createHouseShareLink(house.house_id);
    return { url: share_url, message: houseShareMessage(houseSummary(house), share_url) };
  };

  const withLink = async (fn: (v: { url: string; message: string }) => void | Promise<void>) => {
    setBusy(true);
    try {
      await fn(await build());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the share link');
    } finally {
      setBusy(false);
    }
  };

  const whatsapp = () =>
    withLink(({ message }) => {
      window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
    });

  const copy = () =>
    withLink(async ({ message }) => {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      toast.success('Support link copied');
      setTimeout(() => setCopied(false), 2000);
    });

  return (
    <div className="flex gap-2">
      <Button
        className="flex-1 gap-2 rounded-xl font-semibold"
        disabled={busy}
        onClick={() => setNoteOpen(true)}
      >
        <FileText className="h-4 w-4" />
        Create &amp; Share
      </Button>
      <PromissoryNoteDialog
        open={noteOpen}
        onOpenChange={setNoteOpen}
        supportMode="self"
        initialAmount={Number(house.monthly_rent || 0) || undefined}
        initialHouse={house}
      />
      <Button
        variant="outline"
        className="gap-2 rounded-xl"
        disabled={busy}
        onClick={whatsapp}
        aria-label="Share on WhatsApp"
      >
        <MessageCircle className="h-4 w-4" />
      </Button>
      <Button variant="outline" className="rounded-xl" disabled={busy} onClick={copy} aria-label="Copy support link">
        {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}
