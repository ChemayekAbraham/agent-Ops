import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Info } from 'lucide-react';

interface WalletDisclaimerProps {
  variant?: 'light' | 'dark';
}

export function WalletDisclaimer({ variant = 'light' }: WalletDisclaimerProps) {
  const [show, setShow] = useState(false);

  const isLight = variant === 'light';

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setShow(!show);
        }}
        className={`w-full flex items-center justify-center gap-1 py-1.5 text-[10px] transition-colors ${
          isLight
            ? 'text-muted-foreground hover:text-foreground'
            : 'text-primary-foreground/60 hover:text-primary-foreground/90'
        }`}
      >
        <Info className="h-3 w-3" />
      </button>
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div
              className={`mx-1 mt-1 p-3 rounded-xl text-[10px] leading-relaxed space-y-1 ${
                isLight
                  ? 'bg-muted/50 border border-border/50 text-muted-foreground'
                  : 'bg-primary-foreground/10 border border-primary-foreground/20 text-primary-foreground/80'
              }`}
            >
              <p>📱 <strong>MTN</strong> and <strong>Airtel</strong> are licensed by the <strong>Bank of Uganda</strong> to process payments.</p>
              <p>🏠 <strong>Welile</strong> is a rent facilitation platform — Welile Technologies helps tenants pay daily rent to their landlord.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
