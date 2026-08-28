"use client";

import * as SliderPrimitive from "@radix-ui/react-slider";
import * as React from "react";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
    showTooltip?: boolean;
    tooltipContent?: (value: number) => React.ReactNode;
  }
>(({ className, showTooltip = false, tooltipContent, ...props }, ref) => {
  const [showTooltipState, setShowTooltipState] = React.useState(false);
  const [internalValue, setInternalValue] = React.useState(
    (props.defaultValue as number[]) ?? (props.value as number[]) ?? [0],
  );

  React.useEffect(() => {
    if (props.value !== undefined) {
      setInternalValue(props.value as number[]);
    }
  }, [props.value]);

  const handleValueChange = (newValue: number[]) => {
    setInternalValue(newValue);
    props.onValueChange?.(newValue);
  };

  const handlePointerDown = () => {
    if (showTooltip) {
      setShowTooltipState(true);
    }
  };

  const handlePointerUp = React.useCallback(() => {
    if (showTooltip) {
      setShowTooltipState(false);
    }
  }, [showTooltip]);

  React.useEffect(() => {
    if (showTooltip) {
      document.addEventListener("pointerup", handlePointerUp);
      return () => {
        document.removeEventListener("pointerup", handlePointerUp);
      };
    }
  }, [showTooltip, handlePointerUp]);

  const renderThumb = (value: number) => {
    const thumb = (
      <SliderPrimitive.Thumb
        onPointerDown={handlePointerDown}
        className="block h-4 w-4 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
      />
    );

    if (!showTooltip) return thumb;

    return (
      <Tooltip open={showTooltipState}>
        <TooltipTrigger asChild>{thumb}</TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={8}
          className="px-2 py-1 text-xs font-medium"
        >
          {tooltipContent ? tooltipContent(value) : value}
        </TooltipContent>
      </Tooltip>
    );
  };

  const slider = (
    <SliderPrimitive.Root
      ref={ref}
      className={cn("relative flex w-full touch-none select-none items-center", className)}
      {...props}
      value={internalValue}
      onValueChange={handleValueChange}
    >
      <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-secondary">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      {internalValue?.map((value, index) => (
        <React.Fragment key={index}>{renderThumb(value)}</React.Fragment>
      ))}
    </SliderPrimitive.Root>
  );

  return showTooltip ? (
    <TooltipProvider delayDuration={0}>{slider}</TooltipProvider>
  ) : (
    slider
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
