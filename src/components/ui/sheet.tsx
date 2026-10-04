import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import { useBackAwareOpenState } from "@/hooks/useBackGestureClose";
import { scheduleOverlayLockRelease } from "@/lib/overlayCleanup";

const Sheet = (props: React.ComponentProps<typeof SheetPrimitive.Root>) => {
  const { rootProps, rest } = useBackAwareOpenState(props);
  return <SheetPrimitive.Root {...rootProps} {...rest} />;
};

const SheetTrigger = SheetPrimitive.Trigger;

const SheetClose = SheetPrimitive.Close;

const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-[110] bg-background/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  "fixed z-[120] gap-4 bg-background p-5 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=open]:duration-300",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b border-border data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t border-border ease-[cubic-bezier(0.32,0.72,0,1)] data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom data-[state=closed]:duration-200 data-[state=open]:duration-[380ms]",
        left: "inset-y-0 left-0 h-full w-3/4 border-r border-border data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l border-border data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
        center:
          "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-h-[85vh] w-[95vw] rounded-xl border border-border data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-bottom-10 data-[state=open]:slide-in-from-bottom-10 sm:max-w-2xl lg:max-w-4xl xl:max-w-5xl",
      },
    },
    defaultVariants: {
      side: "right",
    },
  },
);

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  /** Optional class names applied to the backdrop overlay (e.g. to raise z-index) */
  overlayClassName?: string;
}

const SheetContent = React.forwardRef<React.ElementRef<typeof SheetPrimitive.Content>, SheetContentProps>(
  ({ side = "right", className, overlayClassName, children, ...props }, ref) => {
    // If this sheet is torn down while still open (parent subtree remount, route
    // swap, lazy chunk landing) Radix never restores the body — the page ends up
    // frozen behind a washed-out backdrop. Release the lock on unmount.
    React.useEffect(() => scheduleOverlayLockRelease, []);
    return (
      <SheetPortal>
        <SheetOverlay className={overlayClassName} />
        <SheetPrimitive.Content ref={ref} data-sheet-side={side} className={cn("app-sheet-content", sheetVariants({ side }), className)} {...props}>
          {side === "bottom" && (
            <div className="sticky top-0 z-10 flex justify-center bg-gradient-to-b from-background to-background/95 pb-1 pt-2.5">
              <span aria-hidden className="h-1.5 w-11 rounded-full bg-muted-foreground/30" />
            </div>
          )}
          {children}
        </SheetPrimitive.Content>
      </SheetPortal>
    );
  },
);

SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("relative flex flex-col space-y-1 text-center sm:text-left pr-9", className)} {...props}>
    <SheetPrimitive.Close className="absolute right-0 top-0 -mt-1 rounded-full p-2 text-muted-foreground transition-colors hover:text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none">
      <X className="h-4 w-4" />
      <span className="sr-only">Close</span>
    </SheetPrimitive.Close>
    {children}
  </div>
);
SheetHeader.displayName = "SheetHeader";

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title ref={ref} className={cn("text-base font-semibold text-foreground", className)} {...props} />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};