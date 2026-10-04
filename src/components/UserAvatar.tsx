import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import BoringAvatar from 'boring-avatars';

const MARBLE_COLORS = ['#7C3AED', '#A78BFA', '#4C1D95', '#DDD6FE', '#1E1B4B'];

interface UserAvatarProps {
  avatarUrl?: string | null;
  fullName?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = { sm: 32, md: 40, lg: 64 };
const sizeClasses = { sm: 'h-8 w-8', md: 'h-10 w-10', lg: 'h-16 w-16' };

export function UserAvatar({ avatarUrl, fullName, size = 'md', className = '' }: UserAvatarProps) {
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

export { MARBLE_COLORS };
