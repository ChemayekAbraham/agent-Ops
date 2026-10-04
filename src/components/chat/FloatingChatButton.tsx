import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence, useDragControls, PanInfo } from 'framer-motion';
import { MessageCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import { PresenceProvider } from '@/hooks/usePresence';
import ChatDrawer from './ChatDrawer';

const STORAGE_KEY = 'floating-chat-position';

interface Position {
  x: number;
  y: number;
}

export default function FloatingChatButton() {
  const location = useLocation();
  const { user } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const constraintsRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();

  // Don't show on chat page
  const isOnChatPage = location.pathname === '/chat';

  // Load saved position on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        setPosition(parsed);
      }
    } catch {
      // Ignore parse errors
    }
  }, []);

  // Chat unread count DB calls stubbed - use IndexedDB cached data only
  // No realtime subscription for messages to reduce DB load

  const handleClick = () => {
    // Only open drawer if not dragging
    if (!isDragging) {
      hapticTap();
      setDrawerOpen(true);
    }
  };

  const handleDragStart = () => {
    setIsDragging(true);
  };

  const handleDragEnd = (_: any, info: PanInfo) => {
    // Small delay to prevent click after drag
    setTimeout(() => setIsDragging(false), 100);
    
    // Save the new position
    const newPosition = {
      x: position.x + info.offset.x,
      y: position.y + info.offset.y
    };
    setPosition(newPosition);
    
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newPosition));
    } catch {
      // Ignore storage errors
    }
  };

  if (isOnChatPage || !user) return null;

  return (
    <PresenceProvider>
      {/* Drag constraints - full viewport */}
      <div 
        ref={constraintsRef} 
        className="fixed inset-0 pointer-events-none z-[59]"
      />
      
      <motion.button
        drag
        dragControls={dragControls}
        dragConstraints={constraintsRef}
        dragElastic={0.1}
        dragMomentum={false}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        initial={{ scale: 0, opacity: 0, x: position.x, y: position.y }}
        animate={{ 
          scale: 1, 
          opacity: 1,
          x: position.x,
          y: position.y
        }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 25
        }}
        whileHover={{ scale: isDragging ? 1 : 1.1 }}
        whileTap={{ scale: 0.95 }}
        whileDrag={{ scale: 1.15, cursor: 'grabbing' }}
        onClick={handleClick}
        className={cn(
          "fixed top-20 md:top-6 right-4 md:right-8 z-[60]",
          "h-14 w-14 md:h-16 md:w-16 rounded-full",
          "bg-gradient-to-br from-primary via-primary to-primary/70",
          "text-primary-foreground",
          "shadow-2xl shadow-primary/50",
          "flex items-center justify-center",
          "transition-shadow duration-300",
          "hover:shadow-primary/70 hover:shadow-2xl",
          "focus:outline-none focus:ring-4 focus:ring-primary/50 focus:ring-offset-2",
          "border-2 border-primary-foreground/30",
          "cursor-grab active:cursor-grabbing touch-none"
        )}
        aria-label="Open chat (drag to move)"
      >
        <MessageCircle className="h-6 w-6 md:h-7 md:w-7 pointer-events-none" strokeWidth={2.5} />

        {/* Unread badge */}
        <AnimatePresence>
          {unreadCount > 0 && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              className={cn(
                "absolute -top-1 -right-1",
                "min-w-[26px] h-[26px] px-2",
                "rounded-full",
                "bg-destructive text-destructive-foreground",
                "text-sm font-bold",
                "flex items-center justify-center",
                "border-2 border-background",
                "shadow-lg pointer-events-none"
              )}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </motion.span>
          )}
        </AnimatePresence>

        {/* Pulse animation for unread */}
        {unreadCount > 0 && (
          <span className="absolute inset-0 rounded-full bg-primary animate-ping opacity-25 pointer-events-none" />
        )}

        {/* Glow effect */}
        <span className="absolute inset-0 rounded-full bg-primary/20 blur-md -z-10 pointer-events-none" />
      </motion.button>

      <ChatDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
    </PresenceProvider>
  );
}
