import { useState } from 'react';
import { FileText, CheckCircle2, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import LandlordAgreementModal from './LandlordAgreementModal';
import { useLandlordAgreement } from '@/hooks/useLandlordAgreement';
import { hapticTap } from '@/lib/haptics';

export default function LandlordAgreementButton() {
  const { isAccepted, isLoading, acceptAgreement } = useLandlordAgreement();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);

  const handleOpenModal = () => {
    hapticTap();
    setIsModalOpen(true);
  };

  const handleAccept = async (): Promise<boolean> => {
    setIsAccepting(true);
    const success = await acceptAgreement();
    setIsAccepting(false);
    return success;
  };

  if (isLoading) {
    return (
      <div className="w-full h-14 rounded-lg bg-muted/50 animate-pulse" />
    );
  }

  return (
    <>
      {isAccepted ? (
        <Button
          variant="outline"
          onClick={handleOpenModal}
          className={cn(
            "w-full justify-between h-auto py-3 px-4",
            "bg-success/5 border-success/30 hover:bg-success/10"
          )}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-success/20">
              <CheckCircle2 className="h-4 w-4 text-success" />
            </div>
            <div className="text-left">
              <p className="font-medium text-sm">Signed agreement on file</p>
              <p className="text-xs text-muted-foreground">Tap to view your terms &amp; benefits</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Button>

      ) : (
        <Button
          onClick={handleOpenModal}
          className={cn(
            "w-full justify-between h-auto py-3 px-4",
            "bg-gradient-to-r from-primary to-success text-white hover:opacity-90"
          )}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/20">
              <FileText className="h-4 w-4" />
            </div>
            <div className="text-left">
              <p className="font-medium text-sm">View Terms &amp; Benefits</p>
              <p className="text-xs opacity-90">A signed agreement is required to list your property</p>
            </div>

          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-card opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-card"></span>
            </span>
            <ChevronRight className="h-4 w-4" />
          </div>
        </Button>
      )}

      <LandlordAgreementModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAccept={handleAccept}
        isAccepting={isAccepting}
        viewOnly={isAccepted}
      />
    </>
  );
}
