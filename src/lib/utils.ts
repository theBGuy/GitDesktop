import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Carried UNCONDITIONALLY by any element whose opacity tracks a query's
 *  placeholder state, so the fade plays both ways; the conditional dim class
 *  rides alongside it. Reduced motion zeroes the duration rather than removing
 *  the transition, so a call site's `delay-*` still holds the dim back. */
export const PLACEHOLDER_FADE =
  "transition-opacity duration-150 motion-reduce:duration-0";
