import { motion } from 'framer-motion';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import BoringAvatar from 'boring-avatars';
import type { EliteTier } from '@/hooks/useEliteRanks';
import { ELITE_TIER_COLORS, EliteGem } from '@/components/agent/EliteRankBadge';

const MARBLE_COLORS = ['#7C3AED', '#A78BFA', '#4C1D95', '#DDD6FE', '#1E1B4B'];

interface UserAvatarProps {
  avatarUrl?: string | null;
  fullName?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** When set, renders a metallic tier ring, soft glow and a small gem badge. */
  eliteTier?: EliteTier | null;
}

const sizeMap = { sm: 32, md: 40, lg: 64 };
const sizeClasses = { sm: 'h-8 w-8', md: 'h-10 w-10', lg: 'h-16 w-16' };

function Base({ avatarUrl, fullName, size = 'md', className = '' }: UserAvatarProps) {
  if (avatarUrl) {
    return (
      <Avatar className={`${sizeClasses[size]} ${className}`}>
        <AvatarImage src={avatarUrl} alt={fullName || 'User avatar'} />
        <AvatarFallback className="bg-primary/10 text-primary">
          <BoringAvatar size={sizeMap[size]} name={fullName || 'user'} variant="marble" colors={MARBLE_COLORS} />
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <div className={`${sizeClasses[size]} ${className} rounded-full overflow-hidden shrink-0 flex items-center justify-center`}>
      <BoringAvatar size={sizeMap[size]} name={fullName || 'user'} variant="marble" colors={MARBLE_COLORS} />
    </div>
  );
}

export function UserAvatar(props: UserAvatarProps) {
  const { eliteTier, size = 'md' } = props;
  if (!eliteTier) return <Base {...props} />;
  const c = ELITE_TIER_COLORS[eliteTier];
  const ringPad = size === 'sm' ? 2 : 3;
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35 }}
      className="relative inline-flex shrink-0 rounded-full"
      style={{ padding: ringPad, background: c.ring, boxShadow: `0 0 12px 1px ${c.glow}` }}
      title={`${c.label} rank`}
    >
      <span className="rounded-full bg-background p-px">
        <Base {...props} />
      </span>
      <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-background p-0.5 shadow">
        <EliteGem tier={eliteTier} size={size === 'lg' ? 'sm' : 'xs'} />
      </span>
    </motion.span>
  );
}

export { MARBLE_COLORS };
