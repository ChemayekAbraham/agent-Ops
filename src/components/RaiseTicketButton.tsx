import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Ticket } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import RaiseTicket from '@/hr/components/RaiseTicket';
import { getMyStaff } from '@/hr/api';
import type { Employee } from '@/hr/types';

export default function RaiseTicketButton() {
  const [staff, setStaff] = useState<Employee | null>(null);
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await getMyStaff();
        if (!cancelled) setStaff(me);
      } catch {
        if (!cancelled) setStaff(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open || !contentRef.current) return;
    const container = contentRef.current;

    const closeIfSuccessful = () => {
      const successNode = container.querySelector('p.text-emerald-600');
      if (successNode && successNode.textContent?.includes('was raised')) {
        setOpen(false);
      }
    };

    closeIfSuccessful();

    const observer = new MutationObserver(closeIfSuccessful);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open]);

  if (!staff) return null;

  return (
    <>
      {!open && (
        <motion.button
          type="button"
          onClick={() => setOpen(true)}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.93 }}
          className={cn(
            "fixed bottom-24 right-4 z-[60] h-11 w-11 rounded-full",
            "bg-primary text-primary-foreground",
            "shadow-lg shadow-primary/30",
            "flex items-center justify-center",
            "border border-white/15",
            "active:scale-95 transition-transform touch-manipulation"
          )}
          aria-label="Raise a ticket"
        >
          <Ticket className="h-5 w-5" aria-hidden="true" />
        </motion.button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent stable className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Raise a ticket</DialogTitle>
          </DialogHeader>
          <div ref={contentRef}>
            <RaiseTicket staffId={staff.id} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
