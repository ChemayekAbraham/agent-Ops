import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ZoomIn } from 'lucide-react';

interface ImageZoomProps {
  src: string;
  alt: string;
  className?: string;
  zoomScale?: number;
}

export function ImageZoom({ src, alt, className = '', zoomScale = 2.5 }: ImageZoomProps) {
  const [isZooming, setIsZooming] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [lensPosition, setLensPosition] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const handleMouseEnter = useCallback(() => {
    setIsZooming(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsZooming(false);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || !imageRef.current) return;

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    
    // Calculate relative position within the image (0 to 1)
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    setMousePosition({ x, y });
    
    // Calculate lens position (centered on cursor)
    const lensX = e.clientX - rect.left;
    const lensY = e.clientY - rect.top;
    setLensPosition({ x: lensX, y: lensY });
  }, []);

  const lensSize = 120; // Size of the magnifying lens

  return (
    <div 
      ref={containerRef}
      className={`relative overflow-hidden cursor-zoom-in ${className}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseMove={handleMouseMove}
    >
      {/* Original Image */}
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        className="w-full h-full object-cover"
        draggable={false}
      />

      {/* Zoom indicator */}
      <AnimatePresence>
        {!isZooming && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute bottom-3 right-3 p-2 rounded-full bg-black/50 backdrop-blur-sm text-white pointer-events-none"
          >
            <ZoomIn className="h-4 w-4" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Magnifying Glass Lens */}
      <AnimatePresence>
        {isZooming && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.15 }}
            className="absolute pointer-events-none z-50"
            style={{
              width: lensSize,
              height: lensSize,
              left: lensPosition.x - lensSize / 2,
              top: lensPosition.y - lensSize / 2,
              borderRadius: '50%',
              border: '3px solid white',
              boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 0 0 1px rgba(255,255,255,0.2)',
              overflow: 'hidden',
            }}
          >
            {/* Zoomed Image */}
            <div
              className="absolute"
              style={{
                width: `${zoomScale * 100}%`,
                height: `${zoomScale * 100}%`,
                left: `${-mousePosition.x * (zoomScale - 1) * 100}%`,
                top: `${-mousePosition.y * (zoomScale - 1) * 100}%`,
                transform: `translate(${-mousePosition.x * lensSize}px, ${-mousePosition.y * lensSize}px)`,
              }}
            >
              <img
                src={src}
                alt={alt}
                className="w-full h-full object-cover"
                draggable={false}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Side-by-side zoom panel for product detail views
interface ImageZoomPanelProps {
  src: string;
  alt: string;
  className?: string;
  zoomScale?: number;
}

export function ImageZoomPanel({ src, alt, className = '', zoomScale = 2 }: ImageZoomPanelProps) {
  const [isZooming, setIsZooming] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = useCallback(() => {
    setIsZooming(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsZooming(false);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    setMousePosition({ x, y });
  }, []);

  return (
    <div className={`flex gap-4 ${className}`}>
      {/* Main Image Container */}
      <div 
        ref={containerRef}
        className="relative flex-1 overflow-hidden rounded-xl cursor-crosshair"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseMove={handleMouseMove}
      >
        <img
          src={src}
          alt={alt}
          className="w-full h-full object-cover"
          draggable={false}
        />

        {/* Hover indicator square */}
        <AnimatePresence>
          {isZooming && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute pointer-events-none border-2 border-primary bg-primary/20"
              style={{
                width: `${100 / zoomScale}%`,
                height: `${100 / zoomScale}%`,
                left: `${mousePosition.x * 100 - 50 / zoomScale}%`,
                top: `${mousePosition.y * 100 - 50 / zoomScale}%`,
              }}
            />
          )}
        </AnimatePresence>

        {/* Zoom hint */}
        <AnimatePresence>
          {!isZooming && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-xs"
            >
              <ZoomIn className="h-3.5 w-3.5" />
              Hover to zoom
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Zoom Panel (appears on hover) */}
      <AnimatePresence>
        {isZooming && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.2 }}
            className="hidden md:block w-80 h-80 overflow-hidden rounded-xl border border-border shadow-2xl bg-card"
          >
            <div
              className="w-full h-full"
              style={{
                backgroundImage: `url(${src})`,
                backgroundSize: `${zoomScale * 100}%`,
                backgroundPosition: `${mousePosition.x * 100}% ${mousePosition.y * 100}%`,
                backgroundRepeat: 'no-repeat',
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
