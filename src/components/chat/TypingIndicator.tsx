import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface TypingIndicatorProps {
  name?: string;
  variant?: 'bubble' | 'inline';
  className?: string;
}

export function TypingIndicator({ name, variant = 'bubble', className }: TypingIndicatorProps) {
  if (variant === 'inline') {
    return (
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className={cn("text-xs text-primary font-medium flex items-center gap-1", className)}
      >
        <span className="truncate max-w-[80px]">{name || 'Someone'}</span>
        <span>is typing</span>
        <span className="flex gap-0.5">
          <motion.span
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1, repeat: Infinity, delay: 0 }}
            className="text-primary"
          >
            .
          </motion.span>
          <motion.span
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1, repeat: Infinity, delay: 0.2 }}
            className="text-primary"
          >
            .
          </motion.span>
          <motion.span
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1, repeat: Infinity, delay: 0.4 }}
            className="text-primary"
          >
            .
          </motion.span>
        </span>
      </motion.span>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.8, y: 10 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className={cn("flex items-center gap-2", className)}
    >
      <div className="bg-gradient-to-br from-primary/20 to-muted rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
        <div className="flex gap-1.5 items-center h-4">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              animate={{
                y: [0, -6, 0],
                scale: [1, 1.2, 1],
              }}
              transition={{
                duration: 0.6,
                repeat: Infinity,
                delay: i * 0.15,
                ease: 'easeInOut',
              }}
              className="w-2 h-2 bg-primary/60 rounded-full"
            />
          ))}
        </div>
      </div>
      {name && (
        <motion.span
          initial={{ opacity: 0, x: -5 }}
          animate={{ opacity: 1, x: 0 }}
          className="text-xs text-muted-foreground"
        >
          {name} is typing...
        </motion.span>
      )}
    </motion.div>
  );
}

export default TypingIndicator;
