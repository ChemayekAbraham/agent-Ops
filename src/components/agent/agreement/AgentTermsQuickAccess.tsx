import { useState } from 'react';
import { FileText, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import AgentAgreementModal from './AgentAgreementModal';
import { hapticTap } from '@/lib/haptics';

export default function AgentTermsQuickAccess() {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleOpenModal = () => {
    hapticTap();
    setIsModalOpen(true);
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={handleOpenModal}
        className="w-full justify-between h-auto py-3 px-4 border-dashed border-primary/30 hover:bg-primary/5"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div className="text-left">
            <p className="font-medium text-sm">Agent Terms & Conditions</p>
            <p className="text-xs text-muted-foreground">Tap to view your agreement</p>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </Button>

      <AgentAgreementModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAccept={async () => true}
        viewOnly
      />
    </>
  );
}
