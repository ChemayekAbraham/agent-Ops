import { useState, useRef, useCallback, useEffect } from 'react';
import { Plus, X, LucideIcon, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { hapticTap, hapticImpact, hapticSuccess, hapticSelection } from '@/lib/haptics';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface FABAction {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost';
}

interface FloatingActionButtonProps {
  actions: FABAction[];
  position?: 'bottom-right' | 'bottom-left' | 'bottom-center';
  className?: string;
}

interface SwipeableActionProps {
  action: FABAction;
  index: number;
  onAction: () => void;
}

function SwipeableAction({ action, index, onAction }: SwipeableActionProps) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const hasTriggeredHaptic = useRef(false);
  const cardRef = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);

  const ACTIVATE_THRESHOLD = 80;
  const HAPTIC_THRESHOLD = 60;

  const updateHaptic = (offset: number) => {
    if (Math.abs(offset) > HAPTIC_THRESHOLD && !hasTriggeredHaptic.current) {
      hapticSelection();
      hasTriggeredHaptic.current = true;
    } else if (Math.abs(offset) < HAPTIC_THRESHOLD) {
      hasTriggeredHaptic.current = false;
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    startX.current = e.clientX;
    moved.current = false;
    setDragging(true);
    cardRef.current?.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    const offset = e.clientX - startX.current;
    if (Math.abs(offset) > 4) moved.current = true;
    // Elastic clamp for parity with previous dragElastic 0.3.
    const clamped = Math.max(-140, Math.min(140, offset));
    setDx(clamped);
    updateHaptic(clamped);
  };

  const finish = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    setDragging(false);
    try { cardRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    const offset = dx;
    hasTriggeredHaptic.current = false;
    setDx(0);
    if (Math.abs(offset) > ACTIVATE_THRESHOLD) {
      hapticSuccess();
      onAction();
    }
  };

  const handleClick = () => {
    // Ignore the click synthesized at the end of a swipe gesture.
    if (moved.current) {
      moved.current = false;
      return;
    }
    hapticTap();
    onAction();
  };

  // Derived visual feedback (previously useTransform-driven).
  const progress = Math.min(Math.abs(dx) / 100, 1);
  const indicatorOpacity = progress;
  const iconScale = 1 + progress * 0.2;
  const bg = dx === 0
    ? 'transparent'
    : dx < 0
      ? 'hsl(var(--destructive))'
      : 'hsl(var(--primary))';

  return (
    <div
      className="relative overflow-hidden rounded-2xl motion-lite-enter"
      style={{ animationDelay: `${index * 0.05}s` }}
    >
      {/* Swipe indicator background */}
      <div
        style={{ background: bg }}
        className="absolute inset-0 rounded-2xl flex items-center justify-between px-4"
      >
        <div
          style={{ opacity: dx < 0 ? indicatorOpacity : 0 }}
          className="flex items-center gap-2 text-destructive-foreground"
        >
          <X className="h-5 w-5" />
          <span className="text-sm font-medium">Cancel</span>
        </div>
        <div
          style={{ opacity: dx > 0 ? indicatorOpacity : 0 }}
          className="flex items-center gap-2 text-primary-foreground"
        >
          <span className="text-sm font-medium">Run</span>
          <ChevronRight className="h-5 w-5" />
        </div>
      </div>

      {/* Draggable action card */}
      <button
        ref={cardRef}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 0.2s ease-out',
          touchAction: 'pan-y',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onClick={handleClick}
        className={cn(
          "relative w-full flex items-center gap-4 p-4 rounded-2xl",
          "bg-secondary/80 hover:bg-secondary active:scale-[0.98]",
          "border border-border/50 hover:border-primary/30",
          "transition-colors duration-200 cursor-grab active:cursor-grabbing"
        )}
      >
        <div
          style={{ transform: `scale(${iconScale})` }}
          className={cn(
            "p-3 rounded-xl shrink-0 transition-transform",
            action.variant === 'destructive'
              ? "bg-destructive/10 text-destructive"
              : "bg-primary/10 text-primary"
          )}
        >
          <action.icon className="h-5 w-5" />
        </div>
        <div className="flex-1 text-left">
          <span className="text-sm font-medium text-foreground">
            {action.label}
          </span>
          <p className="text-xs text-muted-foreground mt-0.5">
            Tap or swipe right to activate
          </p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
      </button>
    </div>
  );
}

export function FloatingActionButton({ 
  actions, 
  position = 'bottom-right',
  className 
}: FloatingActionButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPress = useRef(false);
  const isMobile = useIsMobile();

  const LONG_PRESS_DURATION = 500; // ms

  const startLongPress = useCallback(() => {
    isLongPress.current = false;
    longPressTimer.current = setTimeout(() => {
      isLongPress.current = true;
      hapticSelection();
      setShowPreview(true);
    }, LONG_PRESS_DURATION);
  }, []);

  const endLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (showPreview) {
      setShowPreview(false);
    }
  }, [showPreview]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
      }
    };
  }, []);

  const positionClasses = {
    'bottom-right': 'right-6 bottom-24 md:bottom-6',
    'bottom-left': 'left-6 bottom-24 md:bottom-6',
    'bottom-center': 'left-1/2 -translate-x-1/2 bottom-24 md:bottom-6',
  };

  const handleActionClick = (action: FABAction) => {
    hapticSuccess();
    action.onClick();
    setIsOpen(false);
  };

  const handleFabClick = () => {
    // Don't open if this was a long press
    if (isLongPress.current) {
      isLongPress.current = false;
      return;
    }
    hapticImpact();
    setIsOpen(true);
  };

  const handleFabToggle = () => {
    // Don't toggle if this was a long press
    if (isLongPress.current) {
      isLongPress.current = false;
      return;
    }
    hapticImpact();
    setIsOpen(!isOpen);
  };

  // Keyboard shortcuts for desktop (1-9 to trigger actions, Escape to close)
  useEffect(() => {
    if (isMobile) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape key closes the FAB
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
        return;
      }

      // Number keys trigger actions when FAB is open
      if (isOpen && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const keyNum = parseInt(e.key);
        if (keyNum >= 1 && keyNum <= actions.length) {
          e.preventDefault();
          handleActionClick(actions[keyNum - 1]);
        }
      }

      // Space or Enter opens FAB when it's focused
      if ((e.key === ' ' || e.key === 'Enter') && !isOpen) {
        const activeElement = document.activeElement;
        if (activeElement?.closest('[data-fab-trigger]')) {
          e.preventDefault();
          setIsOpen(true);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isMobile, actions]);

  // Preview tooltip component for long-press
  const PreviewTooltip = () => {
    if (!showPreview) return null;
    return (
      <div className="absolute bottom-full right-0 mb-3 pointer-events-none motion-lite-enter">
        <div className="bg-background/95 backdrop-blur-md border border-border rounded-2xl shadow-2xl p-3 min-w-[200px]">
          <p className="text-xs text-muted-foreground mb-2 text-center font-medium">
            Quick Actions Preview
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
            {actions.map((action, index) => (
              <div
                key={index}
                className="flex flex-col items-center gap-1 motion-lite-enter"
                style={{ animationDelay: `${index * 0.05}s` }}
              >
                <div className={cn(
                  "p-2.5 rounded-xl",
                  action.variant === 'destructive'
                    ? "bg-destructive/10 text-destructive"
                    : "bg-primary/10 text-primary"
                )}>
                  <action.icon className="h-4 w-4" />
                </div>
                <span className="text-[10px] text-muted-foreground max-w-[60px] text-center truncate">
                  {action.label}
                </span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground/70 mt-2 text-center">
            Release to dismiss • Tap to open
          </p>
        </div>
      </div>
    );
  };

  // Mobile: Use bottom sheet drawer with swipeable actions
  if (isMobile) {
    return (
      <>
        <div className={cn('fixed z-50', positionClasses[position], className)}>
          <PreviewTooltip />
          <div className="motion-lite-pop">
            <Button
              size="icon"
              className={cn(
                "h-14 w-14 rounded-full shadow-xl hover:shadow-2xl transition-all duration-300 active:scale-95",
                "bg-primary hover:bg-primary/90",
                isOpen && "bg-destructive hover:bg-destructive/90"
              )}
              onClick={handleFabClick}
              onPointerDown={startLongPress}
              onPointerUp={endLongPress}
              onPointerLeave={endLongPress}
              onPointerCancel={endLongPress}
            >
              <Plus className="h-6 w-6" />
            </Button>
          </div>
        </div>

        <Drawer open={isOpen} onOpenChange={setIsOpen}>
          <DrawerContent className="pb-8">
            <DrawerHeader className="pb-2">
              <DrawerTitle className="text-center">Quick Actions</DrawerTitle>
              <p className="text-xs text-muted-foreground text-center mt-1">
                Swipe right on any action to activate
              </p>
            </DrawerHeader>
            <div className="px-4 pb-4 space-y-2">
              {actions.map((action, index) => (
                <SwipeableAction
                  key={index}
                  action={action}
                  index={index}
                  onAction={() => handleActionClick(action)}
                />
              ))}
            </div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  // Desktop: Use expanding menu
  return (
    <div className={cn('fixed z-50', positionClasses[position], className)}>
      {/* Long-press preview tooltip */}
      <PreviewTooltip />
      {/* Action buttons */}
      {isOpen && (
        <div className="absolute bottom-16 right-0 flex flex-col-reverse gap-3 items-end">
          {actions.map((action, index) => (
            <div
              key={index}
              className="flex items-center gap-3 motion-lite-enter"
              style={{ animationDelay: `${index * 0.06}s` }}
            >
              <span className="px-3 py-1.5 bg-background/95 backdrop-blur-sm border border-border rounded-lg text-sm font-medium shadow-lg whitespace-nowrap flex items-center gap-2">
                {action.label}
                <kbd className="hidden md:inline-flex items-center justify-center h-5 w-5 text-[10px] font-mono bg-muted rounded border border-border/50">
                  {index + 1}
                </kbd>
              </span>
              <Button
                size="icon"
                variant={action.variant || 'secondary'}
                className="h-12 w-12 rounded-full shadow-lg hover:shadow-xl transition-shadow relative active:scale-95"
                onClick={() => handleActionClick(action)}
              >
                <action.icon className="h-5 w-5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Main FAB button */}
      <div className="motion-lite-pop">
        <Button
          size="icon"
          data-fab-trigger
          className={cn(
            "h-14 w-14 rounded-full shadow-xl hover:shadow-2xl transition-all duration-300 active:scale-95 hover:scale-105",
            "bg-primary hover:bg-primary/90",
            isOpen && "bg-destructive hover:bg-destructive/90"
          )}
          onClick={handleFabToggle}
          onPointerDown={startLongPress}
          onPointerUp={endLongPress}
          onPointerLeave={endLongPress}
          onPointerCancel={endLongPress}
          aria-label={isOpen ? "Close quick actions" : "Open quick actions"}
          aria-expanded={isOpen}
        >
          <div
            className="transition-transform duration-200"
            style={{ transform: isOpen ? 'rotate(45deg)' : 'rotate(0deg)' }}
          >
            {isOpen ? (
              <X className="h-6 w-6" />
            ) : (
              <Plus className="h-6 w-6" />
            )}
          </div>
        </Button>
      </div>

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-background/20 backdrop-blur-[2px] -z-10 motion-lite-enter"
          onClick={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}
