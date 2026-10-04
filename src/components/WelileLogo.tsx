import { Link } from 'react-router-dom';
import welileLogo from '@/assets/welile-logo.png';

interface WelileLogoProps {
  /** Show "Welile" text next to the logo */
  showText?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Wrap in a link to "/" */
  linkToHome?: boolean;
  /** Logo height class (default h-8) */
  size?: 'sm' | 'md' | 'lg';
  /** Light variant for dark backgrounds (white text) */
  variant?: 'default' | 'light';
}

const sizeMap = {
  sm: 'h-7 sm:h-8 md:h-9',
  md: 'h-9 sm:h-10 md:h-11',
  lg: 'h-14 sm:h-16 md:h-20',
};

export default function WelileLogo({
  showText = true,
  className = '',
  linkToHome = true,
  size = 'md',
  variant = 'default',
}: WelileLogoProps) {
  const content = (
    <div className={`flex items-center gap-2 ${className}`}>
      <img
        src={welileLogo}
        alt="Welile"
        className={`${sizeMap[size]} w-auto rounded-lg`}
      />
      {showText && (
        <span
          className={`text-xl font-bold tracking-tight ${
            variant === 'light' ? 'text-white' : 'text-foreground'
          }`}
        >
          Welile
        </span>
      )}
    </div>
  );

  if (linkToHome) {
    return (
      <Link to="/" className="hover:opacity-90 transition-opacity">
        {content}
      </Link>
    );
  }

  return content;
}
