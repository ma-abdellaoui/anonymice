/**
 * jsdom bootstrap for the harness. jsdom objects match the lib.dom types
 * structurally, so everything downstream just uses DOM names.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

export interface Fixture {
  document: Document;
  window: Window & typeof globalThis;
}

export function loadFixture(path: string): Fixture {
  const dom = new JSDOM(readFileSync(path, 'utf8'), { url: 'https://crm.internal.example/' });
  return {
    document: dom.window.document as unknown as Document,
    window: dom.window as unknown as Window & typeof globalThis,
  };
}

/** Strip every annotation, for the with/without pass of SPEC §9. */
export function stripAnnotations(document: Document): void {
  for (const el of document.querySelectorAll('[data-sensitive]')) el.removeAttribute('data-sensitive');
}
