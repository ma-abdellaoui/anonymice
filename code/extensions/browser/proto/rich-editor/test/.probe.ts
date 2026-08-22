import { editor, IBAN_TOKEN } from './harness.ts';
const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);
const desc = (view.dom as unknown as { pmViewDesc?: object }).pmViewDesc!;
console.log('docView keys:', Object.keys(desc));
console.log('has .view? ', 'view' in desc);
const anyKeyLeadingToView = Object.entries(desc).filter(([, v]) => v && typeof v === 'object' && 'state' in (v as object));
console.log('props holding an EditorState:', anyKeyLeadingToView.map(([k]) => k));
const chip = view.dom.querySelector('[data-anonymice="reveal"]')!;
console.log('chip desc keys:', Object.keys((chip as unknown as { pmViewDesc: object }).pmViewDesc));
