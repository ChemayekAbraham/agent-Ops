import { Lock, FileCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

interface LockedOverlayProps {
  onAcceptClick: () => void;
}

export function LockedOverlay({ onAcceptClick }: LockedOverlayProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="absolute inset-0 z-10 bg-background/80 backdrop-blur-sm rounded-xl flex flex-col items-center justify-center p-6 text-center"
    >
      <div className="p-4 rounded-full bg-muted/50 mb-4">
        <Lock className="h-8 w-8 text-muted-foreground" />
      </div>
      <h4 className="font-bold text-foreground mb-2">
        Locked: Accept Agreement to Continue
      </h4>
      <p className="text-sm text-muted-foreground mb-4 max-w-xs">
        You must accept the Supporter Participation Agreement before supporting tenants.
      </p>
      <Button
        onClick={onAcceptClick}
        className="gap-2 bg-primary hover:bg-primary/90"
      >
        <FileCheck className="h-4 w-4" />
        Accept Agreement
      </Button>
    </motion.div>
  );
}
