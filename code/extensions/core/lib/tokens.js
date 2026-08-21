// Token surface forms. See docs/USER_FLOWS.md §0.2.

export const CLASSES = Object.freeze({
  PER: 'PER',       // person / entity name
  IBAN: 'IBAN',
  AHV: 'AHV',       // Swiss social security number
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  CONTRACT: 'CONTRACT',
  ADDR: 'ADDR',
  CARD: 'CARD'
});

// High-confidence classes may never be waved through by a user override.
export const HIGH_CONFIDENCE = new Set([
  CLASSES.IBAN, CLASSES.AHV, CLASSES.CARD, CLASSES.CONTRACT
]);

export const OPAQUE_RE = /⟦([A-Z]+)·([0-9a-f]{5,16})⟧/g;

export function renderOpaque(cls, digest) {
  return `⟦${cls}·${digest}⟧`;
}

// Format-preserving surrogates keep an LLM able to reason and keep a
// receiving field's validation happy. Derived from the digest so they are
// stable for the same entity. Dev-grade generators; a real deployment wants a
// proper FPE scheme per class.
const SURNAMES = ['Brunner', 'Keller', 'Baumann', 'Frei', 'Marti', 'Zbinden'];
const GIVEN = ['Nadja', 'Reto', 'Silvia', 'Andrin', 'Céline', 'Urs'];

// Digests are short; repeat them so fixed-width surrogates never come out
// with empty groups (`CH57 0000 ea71 05  0`).
function fill(digest, n) {
  let s = digest;
  while (s.length < n) s += digest;
  return s.slice(0, n);
}

export function renderSurrogate(cls, digest) {
  // 6 hex chars keeps n < 2^24, so plain arithmetic stays safe (bit shifts
  // coerce to int32 and go negative on larger digests).
  const n = parseInt(fill(digest, 6), 16);
  const d = fill(digest, 12);
  switch (cls) {
    case CLASSES.PER:
      return `${GIVEN[n % GIVEN.length]} ${SURNAMES[Math.floor(n / 7) % SURNAMES.length]}`;
    case CLASSES.EMAIL:
      return `user.${d.slice(0, 6)}@example.invalid`;
    case CLASSES.IBAN:
      return `CH${String(n % 100).padStart(2, '0')} 0000 ${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8, 12)} 0`;
    case CLASSES.AHV:
      return `756.${String(n % 10000).padStart(4, '0')}.${String(Math.floor(n / 13) % 10000).padStart(4, '0')}.${String(n % 100).padStart(2, '0')}`;
    case CLASSES.PHONE:
      return `+41 44 ${String(n % 1000).padStart(3, '0')} ${String(Math.floor(n / 11) % 100).padStart(2, '0')} ${String(Math.floor(n / 17) % 100).padStart(2, '0')}`;
    default:
      return renderOpaque(cls, digest);
  }
}

export function render(cls, digest, style) {
  return style === 'surrogate' ? renderSurrogate(cls, digest) : renderOpaque(cls, digest);
}
