import { useState, useRef, useEffect, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronUp, LucideIcon } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';

interface CollapsibleAgentSectionProps {
  icon: LucideIcon;
  label: string;
  pendingCount?: number;
  totalCount?: number;
  pendingLabel?: string;
  iconColor?: string;
  children: ReactNode;
  isOpen?: boolean;
  onToggle?: () => void;
}

export function CollapsibleAgentSection({
  icon: Icon,
  label,
  pendingCount = 0,
  totalCount,
  pendingLabel = 'pending',
  iconColor = 'text-primary',
  children,
  isOpen: controlledIsOpen,
  onToggle,
}: CollapsibleAgentSectionProps) {
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  const isControlled = controlledIsOpen !== undefined;
  const isOpen = isControlled ? controlledIsOpen : internalIsOpen;

  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [isOpen, children]);

  const toggleOpen = () => {
    hapticTap();
    if (isControlled && onToggle) {
      onToggle();
    } else {
      setInternalIsOpen(!internalIsOpen);
    }
  };

  const displayCount = totalCount !== undefined ? totalCount : pendingCount;

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        onClick={toggleOpen}
        className="w-full justify-between h-12 px-4 border-dashed"
      >
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${iconColor}`} />
          <span className="font-medium">{label}</span>
          {displayCount > 0 && (
            <Badge 
              variant="outline" 
              className={pendingCount > 0 
                ? "bg-warning/10 text-warning border-warning/30 text-xs px-1.5 py-0.5"
                : "bg-muted text-muted-foreground text-xs px-1.5 py-0.5"
              }
            >
              {pendingCount > 0 ? `${pendingCount} ${pendingLabel}` : displayCount}
            </Badge>
          )}
        </div>
        {isOpen ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </Button>

      <div
        ref={contentRef}
        className="overflow-hidden transition-all duration-200 ease-out"
        style={{
          maxHeight: isOpen ? contentHeight + 'px' : '0px',
          opacity: isOpen ? 1 : 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}
