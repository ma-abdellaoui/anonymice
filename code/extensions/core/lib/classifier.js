// Candidate detection. Emits spans against a flat string.
//
// Tuned for HIGH RECALL, LOW PRECISION — affordable only because the
// destination class already told us this payload is leaving our boundary.
// A false positive costs one click; a false negative costs the promise.

import { CLASSES } from './tokens.js';

const RULES = [
  { cls: CLASSES.AHV, confidence: 0.99, re: /\b756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}\b/g },
  { cls: CLASSES.IBAN, confidence: 0.98, re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,4}\b/g, check: iban },
  { cls: CLASSES.CARD, confidence: 0.95, re: /\b(?:\d[ -]?){13,19}\b/g, check: luhn },
  { cls: CLASSES.EMAIL, confidence: 0.95, re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { cls: CLASSES.PHONE, confidence: 0.85, re: /(?:\+41|0)[ ]?\(?\d{2}\)?[ ]?\d{3}[ ]?\d{2}[ ]?\d{2}\b/g },
  { cls: CLASSES.CONTRACT, confidence: 0.90, re: /\b(?:VTR|CTR|VN)[- ]?\d{4,10}\b/gi },
  { cls: CLASSES.ADDR, confidence: 0.70, re: /\b[A-ZÄÖÜ][\wäöüéè-]+(?:strasse|weg|gasse|platz)\s+\d+[a-z]?\b/g },
  // Name detection is a gazetteer + shape heuristic in a real build. The
  // shape rule alone is the single largest false-positive source in a wiki
  // full of code, product names and Jira keys — see suppression below.
  { cls: CLASSES.PER, confidence: 0.55, re: /\b[A-ZÄÖÜ][a-zäöüéèà]{2,}\s+[A-ZÄÖÜ][a-zäöüéèà]{2,}\b/g }
];

// Shape-based name detection fires on any two capitalised words, so a leading
// common noun swallows the real first name (`Kunde Anna` masked, `Meier` left
// exposed). A stoplist is a cheap patch; the real fix is a gazetteer + entity
// resolution on the vault side.
const LEADING_STOP = new Set([
  'Kunde', 'Kundin', 'Herr', 'Frau', 'Firma', 'Vertrag', 'Rechnung', 'Projekt',
  'Meeting', 'Notiz', 'Kontakt', 'Adresse', 'Datum', 'Betreff', 'Name',
  'Customer', 'Client', 'Contact', 'Contract', 'Invoice', 'Project', 'Subject'
]);

// Regions where shape-based name detection is suppressed outright.
const SUPPRESS = [
  /```[\s\S]*?```/g,           // fenced code
  /`[^`\n]+`/g,                // inline code
  /\b[A-Z]{2,10}-\d+\b/g,      // Jira keys
  /https?:\/\/\S+/g            // URLs
];

function suppressedRanges(text) {
  const out = [];
  for (const re of SUPPRESS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function inRanges(ranges, start, end) {
  return ranges.some(([a, b]) => start < b && end > a);
}

export function classify(text, opts = {}) {
  const { caretOffset = null } = opts;
  const suppressed = suppressedRanges(text);
  const spans = [];

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let m; (m = rule.re.exec(text)); ) {
      const start = m.index, end = start + m[0].length;
      if (rule.check && !rule.check(m[0])) continue;
      if (rule.confidence < 0.8 && inRanges(suppressed, start, end)) continue;
      if (rule.cls === CLASSES.PER && LEADING_STOP.has(m[0].split(/\s+/)[0])) {
        // Retry from just after the stopword so the real name is not skipped.
        rule.re.lastIndex = start + m[0].indexOf(' ') + 1;
        continue;
      }

      // Never classify the value under the caret: `CH93 0076 2011` is a valid
      // IBAN prefix and the user is still typing. The chokepoint sweep covers
      // the gap if an autosave fires meanwhile (docs/USER_FLOWS.md §2).
      if (caretOffset !== null && caretOffset > start && caretOffset <= end) continue;

      spans.push({ start, end, cls: rule.cls, value: m[0], confidence: rule.confidence });
    }
  }
  return spans;
}

// The dumb, unconditional gate. Runs on serialized payloads at egress with no
// caret exemption and no suppression: anything that still looks live is masked.
export function sweep(text) {
  return classify(text, { caretOffset: null })
    .filter((s) => s.confidence >= 0.55);
}

function luhn(s) {
  const d = s.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(d)) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = +d[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function iban(s) {
  const v = s.replace(/\s/g, '').toUpperCase();
  if (v.length < 15 || v.length > 34) return false;
  const r = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const code = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const c of code) rem = (rem * 10 + +c) % 97;
  }
  return rem === 1;
}
