import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Carried UNCONDITIONALLY by any element whose opacity tracks a query's
 *  placeholder state, so the fade plays both ways; the conditional dim class
 *  rides alongside it. */
export const PLACEHOLDER_FADE =
  "transition-opacity duration-150 motion-reduce:transition-none";
