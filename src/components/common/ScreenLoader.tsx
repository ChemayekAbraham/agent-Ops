import ThreeBodyLoader from '@/components/common/ThreeBodyLoader';

interface ScreenLoaderProps {
  /** Optional caption rendered under the dots. */
  label?: string;
  /** Dot cluster size in px. Defaults to 32. */
  size?: number;
  /** Extra classes on the outer container. */
  className?: string;
  /** Full viewport height (default) or an inline padded block. */
  fullScreen?: boolean;
}

/**
 * The single approved screen-level loading surface: three rotating dots
 * centred on the page. Inline/button spinners stay as small icon spinners.
 */
export default function ScreenLoader({
  label,
  size = 32,
  className,
  fullScreen = true,
}: ScreenLoaderProps) {
  return (
    <div
      className={`${fullScreen ? 'min-h-screen' : 'py-12'} w-full flex flex-col items-center justify-center gap-3 bg-background${className ? ` ${className}` : ''}`}
    >
      <ThreeBodyLoader size={size} />
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
    </div>
  );
}