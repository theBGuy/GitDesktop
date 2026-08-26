import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
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

function Dialog({ modal, onOpenChange, ...props }: DialogPrimitive.Root.Props) {
  const panelActive = usePanelActive();
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      // `modal` gates both the document scroll lock and the `aria-hidden`
      // marking of everything outside the popup, so a dialog concealed with its
      // panel drops it and hands the visible tab back to the user.
      modal={panelActive && (modal ?? true)}
      onOpenChange={(open, eventDetails) => {
        if (!open && !panelActive && isUserDismissal(eventDetails.reason)) {
          // Cancelling also suppresses Base UI's `preventDefault()` on Escape,
          // leaving the key to the surface the user is looking at.
          eventDetails.cancel();
          return;
        }
        onOpenChange?.(open, eventDetails);
      }}
      {...props}
    />
  );
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ container, ...props }: DialogPrimitive.Portal.Props) {
  // Default to the surrounding panel so a raw portal can't strand over another
  // tab; an explicit `null` still means "a container is coming", never the body.
  const panelContainer = usePanelPortalContainer();
  return (
    <DialogPrimitive.Portal
      data-slot="dialog-portal"
      container={container === undefined ? panelContainer : container}
      {...props}
    />
  );
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  const panelActive = usePanelActive();
  // DialogContent owns the popup ref — no call site passes one, and re-homing
  // focus after a conceal needs the element.
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  // Derived during render because a concealed panel still renders but runs no
  // effects, so the flip back to visible is the only moment an effect can see.
  const [wasConcealed, setWasConcealed] = React.useState(false);
  if (!panelActive && !wasConcealed) setWasConcealed(true);

  React.useLayoutEffect(() => {
    if (!panelActive || !wasConcealed) return;
    // One frame, to outlast the close-time focus-return of the menu or tab
    // control that switched panels. The flag clears inside the frame, not
    // before it: clearing here would re-run this effect and cancel it.
    const frame = requestAnimationFrame(() => {
      setWasConcealed(false);
      const popup = popupRef.current;
      if (popup && !popup.contains(document.activeElement)) popup.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [panelActive, wasConcealed]);

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        // App defaults layered on the vendored primitive (deliberate, kept in
        // sync at this level): `sm:max-w-md` gives dialogs a bit more room —
        // this app's dialogs are full of long branch names. `[&>*]:min-w-0`
        // lets the grid rows shrink instead of being forced wide by their
        // content, and `wrap-break-word` makes an unbreakable identifier wrap —
        // together they stop long branch names from overflowing any dialog.
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] *:min-w-0 -translate-x-1/2 -translate-y-1/2 gap-4 rounded-none bg-popover p-4 text-xs/relaxed wrap-break-word text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
        ref={popupRef}
      >
        {/* Floating UI inside the popup must not portal into a tab panel the
            dialog covers; Base UI still chains it onto this popup's own portal
            node, so pickers keep stacking above the dialog either way. */}
        <PanelPortalReset>{children}</PanelPortalReset>
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1 text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading text-sm font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-xs/relaxed text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
