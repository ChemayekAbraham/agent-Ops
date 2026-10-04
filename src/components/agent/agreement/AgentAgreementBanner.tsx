import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, X, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import AgentAgreementModal from './AgentAgreementModal';

const BANNER_DISMISSED_KEY = 'agent-terms-banner-dismissed';

export default function AgentAgreementBanner() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDismissed, setIsDismissed] = useState(true); // Start hidden to prevent flash

  useEffect(() => {
    const dismissed = localStorage.getItem(BANNER_DISMISSED_KEY);
    setIsDismissed(dismissed === 'true');
  }, []);

  const handleDismiss = () => {
    localStorage.setItem(BANNER_DISMISSED_KEY, 'true');
    setIsDismissed(true);
  };

  if (isDismissed) {
    return null;
  }

  return (
    <>
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
        >
          <Card className="relative overflow-hidden border-blue-500/30 bg-gradient-to-r from-blue-500/5 to-primary/5">
            {/* Dismiss button */}
            <button
              onClick={handleDismiss}
              className="absolute top-2 right-2 p-1.5 rounded-full hover:bg-muted/50 transition-colors"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>

            <div className="p-4 pr-10">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-blue-500/10 shrink-0">
                  <Info className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-sm text-blue-700 dark:text-blue-400">
                    Agent Terms & Conditions
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    By using Welile as an Agent, you agree to our Terms & Conditions. 
                    You are an independent platform partner.
                  </p>
                  
                  <Button
                    onClick={() => setIsModalOpen(true)}
                    variant="link"
                    size="sm"
                    className="h-auto p-0 mt-1 text-xs gap-1"
                  >
                    <FileText className="h-3 w-3" />
                    View Terms
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </motion.div>
      </AnimatePresence>

      <AgentAgreementModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAccept={async () => { handleDismiss(); return true; }}
        viewOnly
      />
    </>
  );
}
