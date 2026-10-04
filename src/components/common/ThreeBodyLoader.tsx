interface ThreeBodyLoaderProps {
  /** Size in px. Defaults to 35. */
  size?: number;
  /** Animation cycle in seconds. Defaults to the CSS value (1.4s). */
  speed?: number;
  className?: string;
}

/**
 * Three-body orbiting-dots loader. Pure CSS (styles live in index.css).
 */
export default function ThreeBodyLoader({ size = 35, speed, className }: ThreeBodyLoaderProps) {
  return (
    <div
      className={`three-body${className ? ` ${className}` : ''}`}
      style={{
        ['--uib-size' as string]: `${size}px`,
        ...(speed ? { ['--uib-speed' as string]: `${speed}s` } : {}),
      }}
      role="status"
      aria-label="Loading"
    >
      <div className="three-body__dot" />
      <div className="three-body__dot" />
      <div className="three-body__dot" />
    </div>
  );
}