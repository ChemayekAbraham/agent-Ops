"use client";

import React, { createContext, useEffect, useRef, useState } from "react";
import type { ImgHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface CarouselProps {
  items: React.JSX.Element[];
  initialScroll?: number;
}

export type SpecialsCard = {
  src: string;
  title: string;
  category?: string;
  content?: React.ReactNode;
};

export const CarouselContext = createContext<{
  onCardClose: (index: number) => void;
  currentIndex: number;
}>({
  onCardClose: () => {},
  currentIndex: 0,
});

export const Carousel = ({
  items,
  initialScroll = 0,
  autoplay = false,
  autoplaySpeed = 0.5,
}: CarouselProps & { autoplay?: boolean; autoplaySpeed?: number }) => {
  const carouselRef = useRef<HTMLDivElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [scrollLeftState, setScrollLeftState] = useState(0);

  // Duplicate items so the scroll can loop seamlessly.
  const loopedItems = [
    ...items,
    ...items.map((item, i) =>
      React.cloneElement(item, { key: `${item.key ?? i}-duplicate` }),
    ),
  ];

  useEffect(() => {
    if (carouselRef.current) carouselRef.current.scrollLeft = initialScroll;
  }, [initialScroll]);

  useEffect(() => {
    if (!autoplay || isHovered || isDragging) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      return;
    }
    const scroll = () => {
      const el = carouselRef.current;
      if (el) {
        el.scrollLeft += autoplaySpeed;
        if (el.scrollLeft >= el.scrollWidth / 2) el.scrollLeft = 0;
        animationRef.current = requestAnimationFrame(scroll);
      }
    };
    animationRef.current = requestAnimationFrame(scroll);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [autoplay, autoplaySpeed, isHovered, isDragging]);

  const step = (dir: -1 | 1) => {
    const el = carouselRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: "smooth" });
  };

  return (
    <div className="relative w-full">
      <div
        ref={carouselRef}
        className={cn(
          "flex w-full overflow-x-auto overscroll-x-contain scroll-smooth py-2 no-scrollbar",
          isDragging ? "cursor-grabbing" : "cursor-grab",
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          setIsDragging(false);
        }}
        onTouchStart={() => setIsHovered(true)}
        onTouchEnd={() => setIsHovered(false)}
        onMouseDown={(e) => {
          setIsDragging(true);
          setStartX(e.pageX - (carouselRef.current?.offsetLeft || 0));
          setScrollLeftState(carouselRef.current?.scrollLeft || 0);
        }}
        onMouseUp={() => setIsDragging(false)}
        onMouseMove={(e) => {
          if (!isDragging || !carouselRef.current) return;
          e.preventDefault();
          const x = e.pageX - (carouselRef.current.offsetLeft || 0);
          carouselRef.current.scrollLeft = scrollLeftState - (x - startX) * 2;
        }}
      >
        <div className="flex flex-row gap-3 pl-1 pr-4">
          {loopedItems.map((item, index) => (
            <motion.div
              key={`carousel-item-${index}`}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: Math.min(index, 6) * 0.05, ease: "easeOut" }}
              className="rounded-2xl"
            >
              {item}
            </motion.div>
          ))}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-y-0 left-0 right-0 hidden items-center justify-between px-1 sm:flex">
        <button
          type="button"
          aria-label="Previous"
          onClick={() => step(-1)}
          className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background/90 shadow-sm backdrop-blur transition hover:bg-background"
        >
          <ChevronLeft className="h-4 w-4 text-foreground" />
        </button>
        <button
          type="button"
          aria-label="Next"
          onClick={() => step(1)}
          className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background/90 shadow-sm backdrop-blur transition hover:bg-background"
        >
          <ChevronRight className="h-4 w-4 text-foreground" />
        </button>
      </div>
    </div>
  );
};

export const Card = ({
  card,
  index,
  onClick,
}: {
  card: SpecialsCard;
  index?: number;
  onClick?: () => void;
}) => {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label={card.title}
        className="relative block h-56 w-[220px] shrink-0 overflow-hidden rounded-2xl border border-border bg-muted/40 text-left shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:h-64 sm:w-[260px]"
      >
        <BlurImage
          src={card.src}
          alt={card.title}
          className="h-full w-full object-contain"
          onClick={(e) => {
            e.stopPropagation();
            setLightboxOpen(true);
          }}
        />
        {(card.category || card.content) && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6">
            {card.category && (
              <p className="text-[10px] font-semibold uppercase tracking-wider text-white/80">
                {card.category}
              </p>
            )}
            {card.content}
          </div>
        )}
      </button>
      <Lightbox
        src={card.src}
        alt={card.title}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </>
  );
};

export const BlurImage = ({
  src,
  className,
  alt,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { src: string; alt: string }) => {
  const [isLoading, setLoading] = useState(true);
  return (
    <img
      className={cn(
        "transition-opacity duration-300",
        isLoading ? "opacity-0" : "opacity-100",
        className,
      )}
      onLoad={() => setLoading(false)}
      src={src}
      loading="lazy"
      decoding="async"
      alt={alt}
      {...rest}
    />
  );
};

const Lightbox = ({
  src,
  alt,
  isOpen,
  onClose,
}: {
  src: string;
  alt: string;
  isOpen: boolean;
  onClose: () => void;
}) => {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, onClose]);

  if (!mounted) return null;

  const content = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label={`Expanded view of ${alt}`}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          <motion.img
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.2 }}
            src={src}
            alt={alt}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );

  return createPortal(content, document.body);
};

export default Carousel;