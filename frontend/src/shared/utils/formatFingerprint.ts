/** A certificate fingerprint as people compare it by eye: four-character groups
 *  separated by spaces, so a line can wrap only between groups. Display only —
 *  copy and send the plain hex. */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(' ') ?? fingerprint;
}
