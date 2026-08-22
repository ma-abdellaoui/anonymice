import { JSDOM } from 'jsdom';

/** A document from a body fragment, for tests that need real nodes and Ranges. */
export function domFrom(bodyHtml: string): Document {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://crm.internal.example/',
  });
  return dom.window.document as unknown as Document;
}
