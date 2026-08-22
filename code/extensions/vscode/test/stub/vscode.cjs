/** Enough of the VS Code API to activate the extension out of process. */
const noopDisposable = { dispose() {} };
const emitter = () => {
  const hs = [];
  const on = (h) => { hs.push(h); return noopDisposable; };
  on.fire = (e) => { for (const h of hs) h(e); };
  return on;
};

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
  constructor(a, b) { this.start = a; this.end = b; }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}
class Selection extends Range {}
class MarkdownString { constructor(v) { this.value = v; } }
class ThemeColor { constructor(id) { this.id = id; } }

class DocumentDropOrPasteEditKind {
  constructor(value) { this.value = value; }
  append(...parts) { return new DocumentDropOrPasteEditKind([this.value, ...parts].join('.')); }
}
DocumentDropOrPasteEditKind.Text = new DocumentDropOrPasteEditKind('text');
DocumentDropOrPasteEditKind.Empty = new DocumentDropOrPasteEditKind('');

class WorkspaceEdit {
  constructor() { this.entries = []; }
  replace(uri, range, newText) { this.entries.push({ uri, range, newText }); }
}

class DocumentPasteEdit {
  constructor(insertText, title, kind) { this.insertText = insertText; this.title = title; this.kind = kind; }
}

const registered = new Map();
const decorationTypes = [];
const clipboard = { text: '' };
const state = {
  config: {}, quickPickAnswer: undefined, warningAnswer: undefined,
  messages: [], applyEdit: undefined,
};

const window = {
  activeTextEditor: undefined,
  visibleTextEditors: [],
  createTextEditorDecorationType(opts) {
    const t = { key: `d${decorationTypes.length}`, opts, dispose() {} };
    decorationTypes.push(t);
    return t;
  },
  createStatusBarItem() {
    return { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} };
  },
  onDidChangeVisibleTextEditors: emitter(),
  onDidChangeActiveTextEditor: emitter(),
  onDidChangeTextEditorSelection: emitter(),
  showInformationMessage(m) { state.messages.push(m); return Promise.resolve(undefined); },
  showWarningMessage(m) { state.messages.push(m); return Promise.resolve(state.warningAnswer); },
  showQuickPick() { return Promise.resolve(state.quickPickAnswer); },
  setStatusBarMessage() { return noopDisposable; },
};

const workspace = {
  getConfiguration(_section, _scope) {
    return { get: (k, d) => (k in state.config ? state.config[k] : d) };
  },
  asRelativePath(uri) { return String(uri).replace(/^file:\/\//, '').replace(/^\/+/, ''); },
  getWorkspaceFolder() { return { uri: { toString: () => 'file:///demo' } }; },
  onDidChangeTextDocument: emitter(),
  onDidChangeConfiguration: emitter(),
  /** Applies against original offsets, back to front, as the real API does. */
  applyEdit(edit) {
    if (!state.applyEdit) return Promise.resolve(false);
    const ordered = [...edit.entries].sort((a, b) => b.range.start.character - a.range.start.character);
    state.applyEdit(ordered);
    return Promise.resolve(true);
  },
};

const commands = {
  registerCommand(id, fn) { registered.set(id, fn); return noopDisposable; },
  executeCommand(id, ...args) {
    if (id === 'setContext') return Promise.resolve();
    const fn = registered.get(id);
    return Promise.resolve(fn ? fn(...args) : undefined);
  },
};

const languages = { registerDocumentPasteEditProvider() { return noopDisposable; } };
const env = { clipboard: { writeText(t) { clipboard.text = t; return Promise.resolve(); }, readText() { return Promise.resolve(clipboard.text); } } };

module.exports = {
  Position, Range, Selection, MarkdownString, ThemeColor,
  DocumentDropOrPasteEditKind, DocumentPasteEdit,
  StatusBarAlignment: { Right: 2, Left: 1 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  WorkspaceEdit,
  window, workspace, commands, languages, env,
  Disposable: noopDisposable,
  __test: { registered, decorationTypes, clipboard, state },
};
