/** Whether the user agent produced `e`. Its own module so the seam test can
 *  stand in for the user agent without reaching into the DOM implementation. */
export function isTrustedEvent(e: Event): boolean {
  return e.isTrusted;
}
