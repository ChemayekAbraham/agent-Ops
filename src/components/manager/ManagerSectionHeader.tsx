import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';

interface ManagerSectionHeaderProps {
  title: string;
  subtitle: string;
  emoji: string;
  onBack: () => void;
  accentClass?: string;
}

export function ManagerSectionHeader({ title, subtitle, emoji, onBack, accentClass }: ManagerSectionHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-1"
    >
      <button
        onClick={() => { hapticTap(); onBack(); }}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors touch-manipulation mb-2"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Dashboard
      </button>
      <div className="flex items-center gap-2.5">
        <span className="text-2xl">{emoji}</span>
        <div>
          <h2 className={cn("text-lg font-bold tracking-tight", accentClass)}>{title}</h2>
          <p className="text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>
    </motion.div>
  );
}
