import { useState } from 'react';
import { motion } from 'framer-motion';
import { FileCheck, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import AgentAgreementModal from './AgentAgreementModal';
import { useAgentAgreement } from '@/hooks/useAgentAgreement';
import { hapticTap } from '@/lib/haptics';

export default function AgentAgreementButton() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const { isAccepted, isLoading, acceptAgreement } = useAgentAgreement();

  const handleOpenModal = () => {
    hapticTap();
    setIsModalOpen(true);
  };

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      return await acceptAgreement();
    } finally {
      setIsAccepting(false);
    }
  };

  if (isLoading) {
    return null;
  }

  // Hide completely once accepted
  if (isAccepted) {
    return null;
  }

  return (
    <>
      <motion.div className="relative">
        <Button
          onClick={handleOpenModal}
          size="sm"
          className={cn(
            "relative px-3 py-1.5 h-auto text-xs font-medium",
            "bg-primary hover:bg-primary/90"
          )}
        >
          <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
          Accept Agent Terms
        </Button>
        
        {/* Red dot indicator */}
        <span className="absolute -top-1 -right-1 h-2.5 w-2.5 bg-red-500 rounded-full animate-pulse" />
      </motion.div>

      <AgentAgreementModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAccept={handleAccept}
        isAccepting={isAccepting}
      />
    </>
  );
}
