import { useState } from 'react';
import { FileText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { PromissoryNoteDialog } from '@/components/agent/PromissoryNoteDialog';
import { type SupportableHouse } from '@/components/partner/SelfSupportHousesSection';

/**
 * Share actions for one empty house.
 *
 * The primary action opens the self-support promissory note dialog so the agent
 * creates the note and shares its activation link from there.
 */
export function HouseShareActions({ house }: { house: SupportableHouse }) {
  const [noteOpen, setNoteOpen] = useState(false);

  return (
    <div className="flex gap-2">
      <Button
        className="flex-1 gap-2 rounded-xl font-semibold"
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
    </div>
  );
}
