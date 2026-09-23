/**
 * Shared IANA timezone validation. `capsules.service.ts` and
 * `scheduled-messages.service.ts` both already reject an invalid timezone at
 * write time (e.g. when a capsule/scheduled-message request supplies one).
 * But a user's *profile* timezone (`User.timezone`, set at registration and
 * editable via PATCH /users/me) was never validated the same way — and both
 * of those services fall back to the owner's profile timezone whenever the
 * caller doesn't pass an explicit override. A bad profile value (anything
 * that isn't a real IANA zone, e.g. "America" instead of "America/New_York")
 * then surfaces as a confusing 400 on capsule/scheduled-message creation with
 * no obvious link back to the profile setting that caused it.
 *
 * Validating at the source (registration + profile update) closes that gap.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
