"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode4 = __toESM(require("vscode"), 1);

// src/ext/detect-controller.ts
var vscode = __toESM(require("vscode"), 1);

// src/lib/types.ts
var CLASSES = [
  "PERSON",
  "IBAN",
  "CARD",
  "AHV",
  "PHONE",
  "EMAIL",
  "ADDR",
  "ORG",
  "SECRET",
  "UNKNOWN"
];
function isCls(v) {
  return CLASSES.includes(v);
}

// src/lib/tokens.ts
var SIGIL = "ANM1";
var ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
var PAYLOAD_LEN = 16;
var CHECK_LEN = 1;
var CORE_LEN = PAYLOAD_LEN + CHECK_LEN;
var ALIASES = { I: "1", L: "1", O: "0" };
var IGNORABLE = /[\u200B-\u200F\u00AD\u2060\uFEFF\u00A0]/g;
var HYPHENS = /[\u2010-\u2015\u2212\uFE63\uFF0D]/g;
var SCAN = /\bANM1-([A-Z]{2,10})-((?:[0-9A-Z]-?){16}[0-9A-Z])\b/g;
function symbolValue(c) {
  return ALPHABET.indexOf(c);
}
function checkChar(payload) {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    sum += (symbolValue(payload[i]) + 1) * (i + 1);
  }
  return ALPHABET[sum % 32];
}
function encode80(bytes) {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = acc << 8 | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[acc >>> bits & 31];
    }
  }
  return out;
}
function mintToken(cls) {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const payload = encode80(bytes);
  return `${SIGIL}-${cls}-${payload}${checkChar(payload)}`;
}
function normalizeText(s) {
  return s.normalize("NFKC").replace(IGNORABLE, "").replace(HYPHENS, "-").toUpperCase();
}
function canonicalCore(raw) {
  let out = "";
  for (const c of raw.replace(/-/g, "")) out += ALIASES[c] ?? c;
  return out;
}
function coreIsWellFormed(core) {
  if (core.length !== CORE_LEN) return false;
  for (const c of core) if (!ALPHABET.includes(c)) return false;
  return true;
}
function parseToken(input) {
  const text = normalizeText(input).trim();
  const m = new RegExp(`^${SCAN.source}$`).exec(text);
  if (!m) {
    const loose = /^ANM1-([A-Z]{2,10})-([0-9A-Z-]{1,40})$/.exec(text);
    return loose ? { kind: "damaged", cls: loose[1] } : { kind: "none" };
  }
  const cls = m[1];
  const core = canonicalCore(m[2]);
  if (!coreIsWellFormed(core)) return { kind: "damaged", cls };
  const payload = core.slice(0, PAYLOAD_LEN);
  if (core[PAYLOAD_LEN] !== checkChar(payload)) return { kind: "damaged", cls };
  return { kind: "token", token: `${SIGIL}-${cls}-${core}`, cls, knownCls: isCls(cls) };
}
function scanTokens(source) {
  let clean = "";
  const map = [];
  for (let i = 0; i < source.length; i++) {
    const ch = normalizeText(source[i]);
    if (ch === "") continue;
    for (const c of ch) {
      clean += c;
      map.push(i);
    }
  }
  map.push(source.length);
  const out = [];
  const re = new RegExp(SCAN.source, "g");
  let m;
  while ((m = re.exec(clean)) !== null) {
    const cls = m[1];
    const core = canonicalCore(m[2]);
    if (!coreIsWellFormed(core)) continue;
    if (core[PAYLOAD_LEN] !== checkChar(core.slice(0, PAYLOAD_LEN))) continue;
    out.push({
      token: `${SIGIL}-${cls}-${core}`,
      cls,
      knownCls: isCls(cls),
      start: map[m.index],
      end: map[m.index + m[0].length]
    });
  }
  return out;
}
function looksLikeToken(s) {
  return normalizeText(s).includes(`${SIGIL}-`);
}

// src/lib/detect.ts
function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
var IBAN_LEN = {
  AT: 20,
  BE: 16,
  CH: 21,
  DE: 22,
  DK: 18,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  IE: 22,
  IT: 27,
  LI: 21,
  LU: 20,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  SE: 24
};
function ibanValid(compact2) {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(compact2)) return false;
  const expected = IBAN_LEN[compact2.slice(0, 2)];
  if (expected !== void 0 && compact2.length !== expected) return false;
  const moved = compact2.slice(4) + compact2.slice(0, 4);
  let rem = 0;
  for (const c of moved) {
    const v = c >= "A" && c <= "Z" ? String(c.charCodeAt(0) - 55) : c;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}
function ahvValid(compact2) {
  if (!/^756[0-9]{10}$/.test(compact2)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (compact2.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  return (10 - sum % 10) % 10 === compact2.charCodeAt(12) - 48;
}
function cardIssuer(digits) {
  const n = digits.length;
  const p2 = Number(digits.slice(0, 2));
  const p4 = Number(digits.slice(0, 4));
  if (n === 16 && digits[0] === "4") return "visa";
  if (n === 13 && digits[0] === "4") return "visa";
  if (n === 19 && digits[0] === "4") return "visa";
  if (n === 16 && p2 >= 51 && p2 <= 55) return "mastercard";
  if (n === 16 && p4 >= 2221 && p4 <= 2720) return "mastercard";
  if (n === 15 && (p2 === 34 || p2 === 37)) return "amex";
  if (n === 16 && (digits.startsWith("6011") || p2 === 65)) return "discover";
  if (n === 16 && p2 === 35) return "jcb";
  if (n === 14 && (p2 === 36 || p2 === 38 || p2 === 30 && "05".includes(digits[2]))) return "diners";
  return void 0;
}
var SECRET_RULES = [
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: "openai-key", re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "stripe-key", re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: "private-key-block", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g }
];
var IBAN_CANDIDATE = /\b[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]){8,32}\b/g;
var CARD_CANDIDATE = /(?<![0-9A-Za-z._-])[0-9](?:[ -]?[0-9]){11,25}(?![0-9A-Za-z._-])/g;
var AHV_CANDIDATE = /(?<![0-9])756[.\s]?[0-9]{4}[.\s]?[0-9]{4}[.\s]?[0-9]{2}(?![0-9])/g;
var EMAIL_CANDIDATE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
function compact(s) {
  return s.replace(/[\s\-.()/]/g, "").toUpperCase();
}
function compactWithMap(raw, offset) {
  let text = "";
  const map = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/[\s\-.()/]/.test(ch)) continue;
    text += ch.toUpperCase();
    map.push(offset + i);
  }
  return { text, map };
}
function firstValidPrefix(cand, lengths, valid) {
  for (const n of lengths) {
    if (n > cand.text.length) continue;
    const slice = cand.text.slice(0, n);
    if (!valid(slice)) continue;
    return { normalized: slice, start: cand.map[0], end: cand.map[n - 1] + 1 };
  }
  return void 0;
}
var IBAN_LENGTHS = Array.from({ length: 20 }, (_, i) => 34 - i);
var CARD_LENGTHS = [19, 16, 15, 14, 13];
function push(out, f) {
  out.push(f);
}
function detect(text) {
  const taken = scanTokens(text).map((t) => ({ start: t.start, end: t.end }));
  const out = [];
  for (const { name, re } of SECRET_RULES) {
    for (const m of text.matchAll(re)) {
      push(out, {
        start: m.index,
        end: m.index + m[0].length,
        cls: "SECRET",
        value: m[0],
        normalized: m[0].trim(),
        rule: name
      });
    }
  }
  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    const cand = compactWithMap(m[0], m.index);
    const country = cand.text.slice(0, 2);
    const known = IBAN_LEN[country];
    const hit = firstValidPrefix(cand, known !== void 0 ? [known] : IBAN_LENGTHS, ibanValid);
    if (!hit) continue;
    push(out, {
      start: hit.start,
      end: hit.end,
      cls: "IBAN",
      value: text.slice(hit.start, hit.end),
      normalized: hit.normalized,
      rule: "iban-mod97"
    });
  }
  for (const m of text.matchAll(AHV_CANDIDATE)) {
    const c = compact(m[0]);
    if (!ahvValid(c)) continue;
    push(out, { start: m.index, end: m.index + m[0].length, cls: "AHV", value: m[0], normalized: c, rule: "ahv-ean13" });
  }
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const cand = compactWithMap(m[0], m.index);
    if (!/^[0-9]+$/.test(cand.text)) continue;
    let issuer;
    const hit = firstValidPrefix(cand, CARD_LENGTHS, (s) => {
      issuer = cardIssuer(s);
      return issuer !== void 0 && luhn(s);
    });
    if (!hit) continue;
    push(out, {
      start: hit.start,
      end: hit.end,
      cls: "CARD",
      value: text.slice(hit.start, hit.end),
      normalized: hit.normalized,
      rule: `card-luhn-${issuer}`
    });
  }
  for (const m of text.matchAll(EMAIL_CANDIDATE)) {
    const at = m[0].lastIndexOf("@");
    push(out, {
      start: m.index,
      end: m.index + m[0].length,
      cls: "EMAIL",
      value: m[0],
      normalized: m[0].slice(0, at) + "@" + m[0].slice(at + 1).toLowerCase(),
      rule: "email"
    });
  }
  return resolveOverlaps(out, taken);
}
function resolveOverlaps(found, taken) {
  const kept = [];
  const sorted = [...found].sort((a, b) => a.start - b.start || b.end - a.end);
  for (const f of sorted) {
    if (taken.some((t) => f.start < t.end && t.start < f.end)) continue;
    const clash = kept.find((k) => f.start < k.end && k.start < f.end);
    if (clash) {
      if (f.end - f.start > clash.end - clash.start) kept[kept.indexOf(clash)] = f;
      continue;
    }
    kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}
function summarize(findings) {
  const counts = /* @__PURE__ */ new Map();
  for (const f of findings) counts.set(f.cls, (counts.get(f.cls) ?? 0) + 1);
  return [...counts.entries()].map(([c, n]) => `${n} ${c}`).join(", ");
}

// src/lib/policy.ts
function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}
function classify(relPath2, rules2) {
  const p = relPath2.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const r of rules2) {
    if (globToRegExp(r.glob).test(p)) return r.class;
  }
  return "UNTRUSTED";
}
function mayScan(cls, workspaceTrusted) {
  return workspaceTrusted && cls !== "UNTRUSTED";
}
function mayReveal(cls, optedIn) {
  return cls === "UNTRUSTED" ? optedIn : true;
}

// src/ext/detect-controller.ts
var DetectController = class {
  /** Light-red, matching the browser extension's paint (browser SPEC §4). */
  #sensitive = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(255, 120, 120, 0.28)",
    borderRadius: "2px",
    overviewRulerColor: "rgba(255, 90, 90, 0.9)",
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });
  #byDoc = /* @__PURE__ */ new Map();
  #rules;
  #relPath;
  #timer;
  constructor(rules2, relPath2) {
    this.#rules = rules2;
    this.#relPath = relPath2;
  }
  findingsFor(doc) {
    return this.#byDoc.get(doc.uri.toString()) ?? [];
  }
  /** Debounced: a keystroke storm must not re-scan on every character. */
  schedule(editor, delayMs = 250) {
    if (this.#timer !== void 0) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.refresh(editor), delayMs);
  }
  refresh(editor) {
    const doc = editor.document;
    const cls = classify(this.#relPath(doc), this.#rules());
    if (cls === "UNTRUSTED" || doc.uri.scheme !== "file") {
      this.#byDoc.delete(doc.uri.toString());
      editor.setDecorations(this.#sensitive, []);
      return;
    }
    void mayScan;
    const findings = detect(doc.getText());
    this.#byDoc.set(doc.uri.toString(), findings);
    editor.setDecorations(
      this.#sensitive,
      findings.map((f) => ({
        range: new vscode.Range(doc.positionAt(f.start), doc.positionAt(f.end)),
        hoverMessage: new vscode.MarkdownString(
          `**Anonymice**: ${f.cls} detected by rule \`${f.rule}\`.

Run *Anonymice: Tokenize All in File* to replace it with a token.`
        )
      }))
    );
  }
  /**
   * The offer (SPEC §6.1): names the count and the classes. Deliberately not a
   * modal — a dialog on every open trains click-through.
   */
  describe(doc) {
    const f = this.findingsFor(doc);
    return f.length === 0 ? void 0 : summarize(f);
  }
  clear(editor) {
    editor.setDecorations(this.#sensitive, []);
  }
  dispose() {
    if (this.#timer !== void 0) clearTimeout(this.#timer);
    this.#sensitive.dispose();
  }
};

// src/ext/paste-provider.ts
var vscode2 = __toESM(require("vscode"), 1);
var PASTE_KIND = vscode2.DocumentDropOrPasteEditKind.Text.append("anonymice", "tokenize");
var AnonymicePasteProvider = class {
  #vault;
  #scopeFor;
  #classify;
  #onRevealNeeded;
  constructor(vault, scopeFor2, classify2, onRevealNeeded) {
    this.#vault = vault;
    this.#scopeFor = scopeFor2;
    this.#classify = classify2;
    this.#onRevealNeeded = onRevealNeeded;
  }
  async provideDocumentPasteEdits(document, _ranges, dataTransfer, _context, token) {
    const item = dataTransfer.get("text/plain");
    if (!item) return void 0;
    const text = await item.asString();
    if (token.isCancellationRequested || text === "") return void 0;
    const scope = this.#scopeFor(document);
    if (looksLikeToken(text)) {
      const parsed = parseToken(text.trim());
      if (parsed.kind === "token") {
        const res = this.#vault.resolve(parsed.token);
        if (res.kind === "value") {
          const alias = await this.#vault.mint({
            cls: res.cls,
            value: res.value,
            normalized: res.value,
            scopeId: scope
          });
          this.#onRevealNeeded(document);
          return [this.#edit(alias, "Paste as Anonymice token")];
        }
        return void 0;
      }
      return void 0;
    }
    const hit = this.#classify(text);
    if (!hit) return void 0;
    const minted = await this.#vault.mint({
      cls: hit.cls,
      value: text,
      normalized: hit.normalized,
      scopeId: scope
    });
    this.#onRevealNeeded(document);
    return [this.#edit(minted, `Paste ${hit.cls} as Anonymice token`)];
  }
  #edit(insertText, title) {
    const edit = new vscode2.DocumentPasteEdit(insertText, title, PASTE_KIND);
    edit.yieldTo = [];
    return edit;
  }
};

// src/ext/reveal-controller.ts
var vscode3 = __toESM(require("vscode"), 1);

// src/lib/reveal.ts
var DATE = new Intl.DateTimeFormat("en-CH", { day: "numeric", month: "short", year: "numeric" });
function describeResolution(r) {
  switch (r.kind) {
    case "value":
      return r.expiringSoon ? { text: `${r.value}  (expires ${DATE.format(r.expiresAt)})`, muted: false } : { text: r.value, muted: false };
    case "tombstone": {
      const t = r.tombstone;
      const when = DATE.format(t.endedAt);
      const from = t.sourceScope ? ` from ${t.sourceScope}` : "";
      return t.state === "revoked" ? { text: `${t.cls} token${from} \u2014 revoked ${when}`, muted: true } : { text: `${t.cls} token${from} \u2014 expired ${when}`, muted: true };
    }
    case "foreign":
      return { text: `a ${r.cls} token from another vault or profile`, muted: true };
    case "damaged":
      return {
        text: r.cls ? `a damaged ${r.cls} token \u2014 it may have been truncated` : "a damaged token \u2014 it may have been truncated",
        muted: true
      };
    case "none":
      return { text: "", muted: true };
  }
}
function planReveal(source, resolve, opts) {
  if (opts.mode === "off" || opts.hidden) return [];
  const out = [];
  for (const m of scanTokens(source)) {
    const r = resolve(m.token);
    if (r.kind === "none") continue;
    const { text, muted } = describeResolution(r);
    if (text === "") continue;
    const multiline = /[\r\n]/.test(text);
    const hide = opts.mode === "substitute" && !multiline && !muted;
    out.push({
      start: m.start,
      end: m.end,
      token: m.token,
      contentText: multiline ? `${r.kind === "value" ? r.cls : "value"} \u2014 open to view` : text,
      hide,
      muted,
      webviewOnly: multiline
    });
  }
  return out;
}

// src/ext/reveal-controller.ts
var RevealController = class {
  /** `annotate`: value rendered after the token. Nothing is hidden. */
  #after = vscode3.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 0.75rem", color: new vscode3.ThemeColor("editorCodeLens.foreground") }
  });
  /** Explanations — expired, revoked, foreign, damaged — render differently from values. */
  #muted = vscode3.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 0.75rem", color: new vscode3.ThemeColor("editorGhostText.foreground"), fontStyle: "italic" }
  });
  /**
   * `substitute`: the token's own characters are hidden and the value is drawn
   * in their place. The hiding works by smuggling `display: none` through
   * `textDecoration`, which VS Code has never promised to keep working — hence
   * `annotate` is the default and this mode is opt-in (SPEC §7.2).
   */
  #hidden = vscode3.window.createTextEditorDecorationType({
    textDecoration: "none; display: none"
  });
  #before = vscode3.window.createTextEditorDecorationType({
    before: { color: new vscode3.ThemeColor("editor.foreground") }
  });
  #hiddenAll = false;
  #resolve;
  #modeFor;
  constructor(resolve, modeFor) {
    this.#resolve = resolve;
    this.#modeFor = modeFor;
  }
  get isHidden() {
    return this.#hiddenAll;
  }
  /** One gesture for screen sharing, not a per-value hunt (SPEC §7.1). */
  setHiddenAll(hidden) {
    this.#hiddenAll = hidden;
    for (const e of vscode3.window.visibleTextEditors) this.refresh(e);
  }
  refresh(editor) {
    const doc = editor.document;
    const mode = this.#modeFor(doc);
    const plan = planReveal(doc.getText(), this.#resolve, { mode, hidden: this.#hiddenAll });
    const after = [];
    const muted = [];
    const hide = [];
    const before = [];
    for (const d of plan) {
      const range = new vscode3.Range(doc.positionAt(d.start), doc.positionAt(d.end));
      const hoverMessage = d.webviewOnly ? new vscode3.MarkdownString("Anonymice: multi-line value \u2014 open the isolated editor to view.") : void 0;
      if (d.hide) {
        hide.push(range);
        before.push({ range, renderOptions: { before: { contentText: d.contentText } }, hoverMessage });
      } else {
        (d.muted ? muted : after).push({
          range,
          renderOptions: { after: { contentText: d.contentText } },
          hoverMessage
        });
      }
    }
    editor.setDecorations(this.#after, after);
    editor.setDecorations(this.#muted, muted);
    editor.setDecorations(this.#hidden, hide);
    editor.setDecorations(this.#before, before);
  }
  clear(editor) {
    for (const t of [this.#after, this.#muted, this.#hidden, this.#before]) {
      editor.setDecorations(t, []);
    }
  }
  dispose() {
    for (const t of [this.#after, this.#muted, this.#hidden, this.#before]) t.dispose();
  }
};

// src/lib/quick-rules.ts
function luhn2(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return digits.length >= 12 && sum % 10 === 0;
}
var IBAN_LEN2 = {
  CH: 21,
  DE: 22,
  FR: 27,
  AT: 20,
  GB: 22,
  IT: 27,
  ES: 24,
  NL: 18,
  BE: 16,
  LI: 21
};
function ibanValid2(compact2) {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(compact2)) return false;
  const expected = IBAN_LEN2[compact2.slice(0, 2)];
  if (expected !== void 0 && compact2.length !== expected) return false;
  const moved = compact2.slice(4) + compact2.slice(0, 4);
  let rem = 0;
  for (const c of moved) {
    const v = c >= "A" && c <= "Z" ? String(c.charCodeAt(0) - 55) : c;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}
function ahvValid2(compact2) {
  if (!/^756[0-9]{10}$/.test(compact2)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (compact2.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  return (10 - sum % 10) % 10 === compact2.charCodeAt(12) - 48;
}
var SECRET_PATTERNS = [
  /^gh[pousr]_[A-Za-z0-9]{36,}$/,
  /^sk-[A-Za-z0-9_-]{20,}$/,
  /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/
];
function quickClassify(input) {
  const text = input.trim();
  if (text === "") return void 0;
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { cls: "SECRET", normalized: text };
  }
  const compact2 = text.replace(/[\s\-.()/]/g, "").toUpperCase();
  if (ibanValid2(compact2)) return { cls: "IBAN", normalized: compact2 };
  if (ahvValid2(compact2)) return { cls: "AHV", normalized: compact2 };
  if (/^[0-9]+$/.test(compact2) && luhn2(compact2)) return { cls: "CARD", normalized: compact2 };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    const at = text.lastIndexOf("@");
    return { cls: "EMAIL", normalized: text.slice(0, at) + "@" + text.slice(at + 1).toLowerCase() };
  }
  return void 0;
}

// src/lib/vault.ts
var DEFAULT_POLICY = {
  idleMs: 12 * 60 * 60 * 1e3,
  maxMs: 7 * 24 * 60 * 60 * 1e3,
  retainMs: 90 * 24 * 60 * 60 * 1e3,
  warnMs: 7 * 24 * 60 * 60 * 1e3
};
function emptyState() {
  return { records: {}, index: {}, aliases: {}, tombstones: {} };
}
var encoder = new TextEncoder();
async function hmacIndex(key, normalized) {
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(normalized.normalize("NFKC")));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
var Vault = class _Vault {
  #state;
  #key;
  #policy;
  #now;
  constructor(state, key, policy, now) {
    this.#state = state;
    this.#key = key;
    this.#policy = policy;
    this.#now = now;
  }
  /** `keyMaterial` is the vault key `k`; it is never emitted and never indexed. */
  static async open(keyMaterial, state = emptyState(), policy = DEFAULT_POLICY, now = Date.now) {
    const key = await crypto.subtle.importKey(
      "raw",
      keyMaterial,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return new _Vault(state, key, policy, now);
  }
  static newKey() {
    const k = new Uint8Array(32);
    crypto.getRandomValues(k);
    return k;
  }
  get state() {
    return this.#state;
  }
  /**
   * Find or create the value record, then find or create its alias for this
   * scope. Same value + same scope ⇒ same token; same value + different scope ⇒
   * a different token (SPEC §6.3).
   */
  async mint(req) {
    const now = this.#now();
    const idx = await hmacIndex(this.#key, req.normalized);
    let recordId = this.#state.index[idx];
    if (recordId === void 0 || this.#state.records[recordId] === void 0) {
      recordId = randomId();
      this.#state.index[idx] = recordId;
      this.#state.records[recordId] = {
        id: recordId,
        cls: req.cls,
        value: req.value,
        normalized: req.normalized,
        mintedAt: now,
        lastResolvedAt: now,
        parentId: req.parentId,
        userModified: req.userModified
      };
    }
    const existing = this.#aliasFor(recordId, req.scopeId, now);
    if (existing) {
      existing.lastUsedAt = now;
      return existing.token;
    }
    const token = mintToken(req.cls);
    this.#state.aliases[token] = {
      token,
      scopeId: req.scopeId,
      valueId: recordId,
      mintedAt: now,
      lastUsedAt: now
    };
    return token;
  }
  #aliasFor(valueId, scopeId, now) {
    for (const a of Object.values(this.#state.aliases)) {
      if (a.valueId !== valueId || a.scopeId !== scopeId) continue;
      if (now - a.lastUsedAt >= this.#policy.idleMs) continue;
      if (now - a.mintedAt >= this.#policy.maxMs) continue;
      return a;
    }
    return void 0;
  }
  /**
   * Resolve a token to its plaintext, or to something legible about why not.
   * A bare failure is never an acceptable answer (SPEC §6.7).
   */
  resolve(candidate) {
    const parsed = parseToken(candidate);
    if (parsed.kind === "none") return { kind: "none" };
    if (parsed.kind === "damaged") return { kind: "damaged", cls: parsed.cls };
    const now = this.#now();
    const alias = this.#state.aliases[parsed.token];
    if (alias) {
      const rec = this.#state.records[alias.valueId];
      if (rec) {
        const expiresAt = rec.lastResolvedAt + this.#policy.retainMs;
        if (now <= expiresAt) {
          rec.lastResolvedAt = now;
          alias.lastUsedAt = now;
          return {
            kind: "value",
            value: rec.value,
            cls: rec.cls,
            expiresAt: now + this.#policy.retainMs,
            expiringSoon: expiresAt - now <= this.#policy.warnMs
          };
        }
        this.#expire(alias, rec, now);
      }
    }
    const tomb = this.#state.tombstones[parsed.token];
    if (tomb) return { kind: "tombstone", tombstone: tomb };
    return { kind: "foreign", cls: parsed.cls };
  }
  #expire(alias, rec, now) {
    this.#state.tombstones[alias.token] = {
      token: alias.token,
      cls: rec.cls,
      mintedAt: alias.mintedAt,
      endedAt: now,
      state: "expired",
      sourceScope: alias.scopeId
    };
    delete this.#state.aliases[alias.token];
    this.#destroyRecordIfOrphaned(rec);
  }
  /**
   * Revocation is immediate and independent of the retention clock, and it kills
   * every derivative: that inheritance is what makes the scheme defensible
   * (SPEC §8.4).
   */
  revoke(token) {
    const now = this.#now();
    const alias = this.#state.aliases[token];
    if (!alias) return 0;
    const rootId = alias.valueId;
    const doomed = /* @__PURE__ */ new Set([rootId]);
    for (const r of Object.values(this.#state.records)) {
      if (r.parentId !== void 0 && doomed.has(r.parentId)) doomed.add(r.id);
    }
    let killed = 0;
    for (const a of Object.values(this.#state.aliases)) {
      if (!doomed.has(a.valueId)) continue;
      const rec = this.#state.records[a.valueId];
      this.#state.tombstones[a.token] = {
        token: a.token,
        cls: rec ? rec.cls : "UNKNOWN",
        mintedAt: a.mintedAt,
        endedAt: now,
        state: "revoked",
        sourceScope: a.scopeId
      };
      delete this.#state.aliases[a.token];
      killed++;
    }
    for (const id of doomed) {
      const rec = this.#state.records[id];
      if (rec) this.#destroyRecordIfOrphaned(rec);
    }
    return killed;
  }
  /** Destroy the plaintext *and* the value index; the tombstone holds neither. */
  #destroyRecordIfOrphaned(rec) {
    for (const a of Object.values(this.#state.aliases)) {
      if (a.valueId === rec.id) return;
    }
    delete this.#state.records[rec.id];
    for (const [idx, id] of Object.entries(this.#state.index)) {
      if (id === rec.id) delete this.#state.index[idx];
    }
  }
};

// src/extension.ts
var KEY_SECRET = "anonymice.vaultKey";
var STATE_KEY = "anonymice.vaultState";
function rules() {
  return vscode4.workspace.getConfiguration("anonymice").get("resources", []);
}
function relPath(doc) {
  return vscode4.workspace.asRelativePath(doc.uri, false);
}
function scopeFor(doc) {
  const folder = vscode4.workspace.getWorkspaceFolder(doc.uri);
  return folder ? folder.uri.toString() : "anonymice:no-workspace";
}
async function loadKey(secrets) {
  const stored = await secrets.get(KEY_SECRET);
  if (stored) return Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
  const key = Vault.newKey();
  await secrets.store(KEY_SECRET, btoa(String.fromCharCode(...key)));
  return key;
}
async function activate(context) {
  const key = await loadKey(context.secrets);
  const persisted = context.globalState.get(STATE_KEY, emptyState());
  const vault = await Vault.open(key, persisted);
  const persist = () => void context.globalState.update(STATE_KEY, vault.state);
  const optedIn = new Set(context.workspaceState.get("anonymice.optedIn", []));
  const rememberOptIn = () => void context.workspaceState.update("anonymice.optedIn", [...optedIn]);
  const modeFor = (doc) => {
    const cls = classify(relPath(doc), rules());
    if (!mayReveal(cls, optedIn.has(doc.uri.toString()))) return "off";
    return vscode4.workspace.getConfiguration("anonymice", doc.uri).get("reveal.mode", "annotate");
  };
  const detector = new DetectController(rules, relPath);
  const reveal = new RevealController((t) => vault.resolve(t), modeFor);
  const status = vscode4.window.createStatusBarItem(vscode4.StatusBarAlignment.Right, 100);
  status.command = "anonymice.revealToggleFile";
  context.subscriptions.push(reveal, detector, status);
  const refreshAll = () => {
    for (const e of vscode4.window.visibleTextEditors) {
      detector.refresh(e);
      reveal.refresh(e);
    }
    updateStatus();
  };
  function updateStatus() {
    const editor = vscode4.window.activeTextEditor;
    if (!editor) {
      status.hide();
      return;
    }
    const cls = classify(relPath(editor.document), rules());
    const on = modeFor(editor.document) !== "off";
    const found = detector.describe(editor.document);
    status.text = reveal.isHidden ? "$(eye-closed) Anonymice: hidden" : found ? `$(warning) Anonymice: ${found} untokenized` : on ? `$(shield) Anonymice: ${cls.toLowerCase()}` : `$(shield) Anonymice: ${cls.toLowerCase()} \xB7 reveal off`;
    status.tooltip = new vscode4.MarkdownString(
      [
        `Resource class **${cls}** (SPEC \xA73).`,
        found ? `Found **${found}** still in plaintext \u2014 run *Anonymice: Tokenize All in File*.` : "_Rule pass found nothing._ Rules cover checksummed classes and vendor-prefixed secrets only \u2014 **names, addresses and free text are not covered** and need the detection backend, which is not wired yet (SPEC \xA75.1).",
        "The buffer holds tokens; values render as decorations, which no other extension can read back (SPEC \xA72.2)."
      ].join("\n\n")
    );
    status.show();
  }
  const paste = new AnonymicePasteProvider(vault, scopeFor, quickClassify, (doc) => {
    optedIn.add(doc.uri.toString());
    rememberOptIn();
    queueMicrotask(refreshAll);
    persist();
  });
  context.subscriptions.push(
    vscode4.languages.registerDocumentPasteEditProvider({ scheme: "file" }, paste, {
      providedPasteEditKinds: [vscode4.DocumentDropOrPasteEditKind.Text.append("anonymice", "tokenize")],
      pasteMimeTypes: ["text/plain"]
    }),
    vscode4.window.onDidChangeVisibleTextEditors(refreshAll),
    vscode4.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) {
        detector.refresh(ed);
        reveal.refresh(ed);
      }
      updateStatus();
    }),
    vscode4.workspace.onDidChangeTextDocument((e) => {
      for (const ed of vscode4.window.visibleTextEditors) {
        if (ed.document !== e.document) continue;
        reveal.refresh(ed);
        detector.schedule(ed);
      }
    }),
    vscode4.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("anonymice")) refreshAll();
    }),
    vscode4.window.onDidChangeTextEditorSelection((e) => {
      void vscode4.commands.executeCommand(
        "setContext",
        "anonymice.armed",
        !e.selections[0]?.isEmpty && modeFor(e.textEditor.document) !== "off"
      );
    }),
    vscode4.commands.registerCommand("anonymice.hideAll", () => {
      reveal.setHiddenAll(true);
      updateStatus();
    }),
    vscode4.commands.registerCommand("anonymice.showAll", () => {
      reveal.setHiddenAll(false);
      updateStatus();
    }),
    /**
     * The §6.1 tokenize action, reached by hand rather than from a detection
     * sweep. Mints a token for the selection and replaces it — an ordinary
     * WorkspaceEdit, so the editor's own undo reverses it.
     */
    vscode4.commands.registerCommand("anonymice.tokenize", async () => {
      const editor = vscode4.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode4.window.showInformationMessage("Anonymice: select the value to tokenize first.");
        return;
      }
      const value = editor.document.getText(editor.selection);
      const hit = quickClassify(value);
      let cls = hit?.cls;
      if (!cls) {
        const picked = await vscode4.window.showQuickPick([...CLASSES], {
          title: "Anonymice: class for this value",
          placeHolder: "The class label is carried inside the token (SPEC \xA76.4)"
        });
        if (!picked) return;
        cls = picked;
      }
      const token = await vault.mint({
        cls,
        value,
        normalized: hit?.normalized ?? value.trim(),
        scopeId: scopeFor(editor.document)
      });
      const ok = await editor.edit((b) => b.replace(editor.selection, token));
      if (!ok) {
        void vscode4.window.showWarningMessage("Anonymice: could not write to this document.");
        return;
      }
      optedIn.add(editor.document.uri.toString());
      rememberOptIn();
      persist();
      refreshAll();
    }),
    /**
     * Copy-as-token. Bound to ctrl+c because there is no supported hook that can
     * change what a copy puts on the system clipboard — `prepareDocumentPaste`
     * never reaches it (SPEC §8.2). The context menu's Copy stays unhooked, and
     * that is survivable only because the buffer holds tokens already (SPEC §8.3).
     */
    vscode4.commands.registerCommand("anonymice.copyToken", async () => {
      const editor = vscode4.window.activeTextEditor;
      if (!editor) return;
      const selected = editor.document.getText(editor.selection);
      try {
        const hit = quickClassify(selected);
        if (hit) {
          const token = await vault.mint({
            cls: hit.cls,
            value: selected,
            normalized: hit.normalized,
            scopeId: scopeFor(editor.document)
          });
          persist();
          await vscode4.env.clipboard.writeText(token);
          void vscode4.window.setStatusBarMessage(`$(shield) Copied as ${hit.cls} token`, 3e3);
          return;
        }
        await vscode4.env.clipboard.writeText(selected);
      } catch {
        await vscode4.env.clipboard.writeText(selected);
      }
    }),
    /**
     * Tokenize every rule-pass finding in the file. One WorkspaceEdit, so the
     * editor's own undo reverses the whole rewrite (SPEC §6.1).
     */
    vscode4.commands.registerCommand("anonymice.tokenizeAll", async () => {
      const editor = vscode4.window.activeTextEditor;
      if (!editor) return;
      detector.refresh(editor);
      const findings = detector.findingsFor(editor.document);
      if (findings.length === 0) {
        void vscode4.window.showInformationMessage(
          "Anonymice: the rule pass found nothing here. It does not cover names, addresses or free text."
        );
        return;
      }
      const summary = detector.describe(editor.document) ?? "";
      const go = await vscode4.window.showWarningMessage(
        `Anonymice: replace ${summary} with tokens in this file?`,
        { modal: false },
        "Tokenize"
      );
      if (go !== "Tokenize") return;
      const scope = scopeFor(editor.document);
      const replacements = [];
      for (const f of findings) {
        const token = await vault.mint({ cls: f.cls, value: f.value, normalized: f.normalized, scopeId: scope });
        replacements.push({
          range: new vscode4.Range(editor.document.positionAt(f.start), editor.document.positionAt(f.end)),
          token
        });
      }
      const edit = new vscode4.WorkspaceEdit();
      for (const r of replacements) edit.replace(editor.document.uri, r.range, r.token);
      const ok = await vscode4.workspace.applyEdit(edit);
      if (!ok) {
        void vscode4.window.showWarningMessage("Anonymice: the edit was rejected; nothing was changed.");
        return;
      }
      optedIn.add(editor.document.uri.toString());
      rememberOptIn();
      persist();
      refreshAll();
      void vscode4.window.setStatusBarMessage(`$(shield) Tokenized ${summary}`, 4e3);
    }),
    /**
     * Destroy every token and every value in the vault. Exists because vault
     * state is persisted (globalState + SecretStorage) and therefore survives a
     * window reload and an uninstall — without this there is no way back to a
     * clean slate for a repeatable test pass.
     */
    vscode4.commands.registerCommand("anonymice.resetVault", async () => {
      const counts = Object.keys(vault.state.records).length;
      const go = await vscode4.window.showWarningMessage(
        `Anonymice: destroy the vault? ${counts} value(s) and every token minted from them become unresolvable. Tokens already written into files will stay in those files and will no longer resolve.`,
        { modal: true },
        "Destroy vault"
      );
      if (go !== "Destroy vault") return;
      await context.globalState.update(STATE_KEY, emptyState());
      await context.workspaceState.update("anonymice.optedIn", []);
      await context.secrets.delete(KEY_SECRET);
      void vscode4.window.showInformationMessage(
        "Anonymice: vault destroyed. Reload the window (Developer: Reload Window) to start clean."
      );
    }),
    vscode4.commands.registerCommand("anonymice.revealToggleFile", () => {
      const editor = vscode4.window.activeTextEditor;
      if (!editor) return;
      const uri = editor.document.uri.toString();
      if (optedIn.has(uri)) optedIn.delete(uri);
      else optedIn.add(uri);
      rememberOptIn();
      refreshAll();
    })
  );
  refreshAll();
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
