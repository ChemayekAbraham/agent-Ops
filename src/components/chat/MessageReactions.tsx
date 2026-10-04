import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SmilePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

interface Reaction {
  emoji: string;
  count: number;
  users: string[];
  hasReacted: boolean;
}

interface MessageReactionsProps {
  messageId: string;
  reactions: Reaction[];
  isOwn: boolean;
  onReactionChange: () => void;
}

const EMOJI_OPTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👏'];

export default function MessageReactions({ 
  messageId, 
  reactions, 
  isOwn,
  onReactionChange 
}: MessageReactionsProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const toggleReaction = async (emoji: string) => {
    if (!user || loading) return;
    // message_reactions table removed - feature not active
    onReactionChange();
  };

  return (
    <div className={cn("flex items-center gap-1 mt-1", isOwn ? "justify-end" : "justify-start")}>
      {/* Existing reactions */}
      <AnimatePresence>
        {reactions.map((reaction) => (
          <motion.button
            key={reaction.emoji}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            onClick={() => toggleReaction(reaction.emoji)}
            disabled={loading}
            className={cn(
              "flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs transition-colors",
              reaction.hasReacted 
                ? "bg-primary/20 border border-primary/30" 
                : "bg-muted hover:bg-muted/80 border border-transparent"
            )}
          >
            <span>{reaction.emoji}</span>
            <span className="text-[10px] text-muted-foreground">{reaction.count}</span>
          </motion.button>
        ))}
      </AnimatePresence>

      {/* Add reaction button */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <SmilePlus className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent 
          className="w-auto p-2" 
          side={isOwn ? "left" : "right"}
          align="center"
        >
          <div className="flex gap-1">
            {EMOJI_OPTIONS.map((emoji) => {
              const existing = reactions.find(r => r.emoji === emoji);
              return (
                <button
                  key={emoji}
                  onClick={() => toggleReaction(emoji)}
                  disabled={loading}
                  className={cn(
                    "text-xl p-1.5 rounded-lg hover:bg-muted transition-colors",
                    existing?.hasReacted && "bg-primary/20"
                  )}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

