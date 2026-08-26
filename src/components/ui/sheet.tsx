import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import * as React from "react";
import {
  isUserDismissal,
  PanelPortalReset,
  usePanelActive,
  usePanelPortalContainer,
} from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Sheet({ modal, onOpenChange, ...props }: SheetPrimitive.Root.Props) {
  const panelActive = usePanelActive();
  return (
    <SheetPrimitive.Root
      data-slot="sheet"
      // Same contract as Dialog (this IS a Base UI Dialog root): `modal` gates
      // the document scroll lock and the `aria-hidden` marking outside the
      // popup, and a concealed sheet must not take the visible tab's dismissals.
      modal={panelActive && (modal ?? true)}
      onOpenChange={(open, eventDetails) => {
        if (!open && !panelActive && isUserDismissal(eventDetails.reason)) {
          eventDetails.cancel();
          return;
        }
        onOpenChange?.(open, eventDetails);
      }}
      {...props}
    />
  );
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ container, ...props }: SheetPrimitive.Portal.Props) {
  // Default to the surrounding panel so a raw portal can't strand over another
  // tab; an explicit `null` still means "a container is coming", never the body.
  const panelContainer = usePanelPortalContainer();
  return (
    <SheetPrimitive.Portal
      data-slot="sheet-portal"
      container={container === undefined ? panelContainer : container}
      {...props}
    />
  );
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 text-xs/relaxed transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left";
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col bg-popover bg-clip-padding text-xs/relaxed text-popover-foreground shadow-lg transition duration-200 ease-in-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          className,
        )}
        {...props}
      >
        {/* Floating UI inside the popup must not portal into a tab panel the
            sheet covers; Base UI still chains it onto this popup's own portal
            node, so pickers keep stacking above the sheet either way. */}
        <PanelPortalReset>{children}</PanelPortalReset>
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-sm font-medium text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-xs/relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
