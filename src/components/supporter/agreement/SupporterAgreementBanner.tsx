import { AlertTriangle, FileCheck, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';

interface SupporterAgreementBannerProps {
  onReviewClick: () => void;
}

export function SupporterAgreementBanner({ onReviewClick }: SupporterAgreementBannerProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (!isExpanded) {
    return (
      <motion.button
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={() => setIsExpanded(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-warning bg-warning/10 hover:bg-warning/20 transition-colors"
      >
        <AlertTriangle className="h-4 w-4 text-warning" />
        <span className="text-sm font-medium text-warning">Action Required</span>
        <ChevronDown className="h-4 w-4 text-warning" />
      </motion.button>
    );
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        className="relative overflow-hidden rounded-xl border border-warning/50 bg-warning/10 p-3"
      >
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-warning shrink-0" />
          <p className="text-sm text-foreground flex-1">
            Accept agreement to support tenants
          </p>
          <Button
            size="sm"
            onClick={onReviewClick}
            className="gap-1.5 bg-warning hover:bg-warning/90 text-warning-foreground font-medium h-8 px-3"
          >
            <FileCheck className="h-3.5 w-3.5" />
            Accept
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsExpanded(false)}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
