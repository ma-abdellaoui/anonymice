/**
 * Class-intrinsic checksums. One implementation, shared by the backend rule pass
 * and by the clone's validation, so the two cannot disagree (SPEC §8.7).
 */

/** ISO 13616 length per country, for the countries we claim to support. */
const IBAN_LENGTHS: Record<string, number> = {
  CH: 21, LI: 21, DE: 22, AT: 20, FR: 27, IT: 27, NL: 18, BE: 16, ES: 24, GB: 22, LU: 20, PT: 25,
};

export function isValidIban(compact: string): boolean {
  const s = compact.toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(s)) return false;
  const expected = IBAN_LENGTHS[s.slice(0, 2)];
  if (expected !== undefined && s.length !== expected) return false;
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 ? String(code - 55) : ch; // A→10 … Z→35
    for (const d of part) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

export function isValidLuhn(compact: string): boolean {
  if (!/^[0-9]{12,19}$/.test(compact)) return false;
  let sum = 0;
  let double = false;
  for (let i = compact.length - 1; i >= 0; i--) {
    let d = compact.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Swiss AHV/AVS: 13 digits, `756` prefix, EAN-13 check digit. */
export function isValidAhv(compact: string): boolean {
  if (!/^756[0-9]{10}$/.test(compact)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (compact.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return check === compact.charCodeAt(12) - 48;
}
