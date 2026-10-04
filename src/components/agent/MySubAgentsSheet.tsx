import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { SubAgentsList } from './SubAgentsList';
import { SubAgentInvitesList } from './SubAgentInvitesList';
import { ShareSubAgentLink } from './ShareSubAgentLink';
import { AddSubAgentSearch } from './AddSubAgentSearch';
import { UsersRound } from 'lucide-react';

interface MySubAgentsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MySubAgentsSheet({ open, onOpenChange }: MySubAgentsSheetProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl overflow-y-auto pb-8">
        <SheetHeader className="pb-4 border-b border-border mb-4">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <UsersRound className="h-5 w-5 text-warning" />
            My Sub-Agents
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-4">
          <AddSubAgentSearch onAdded={() => setRefreshKey((k) => k + 1)} />
          <ShareSubAgentLink />
          <SubAgentInvitesList />
          <SubAgentsList key={refreshKey} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
