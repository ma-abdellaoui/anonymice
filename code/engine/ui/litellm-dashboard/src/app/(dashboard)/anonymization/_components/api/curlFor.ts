import type { EndpointSpec } from "./catalogue";

/**
 * The same call as a shell command.
 *
 * The key is left as `$KEY` rather than printed: the console holds a real
 * credential and a copy button that pasted it into a chat window or a slide
 * would be a worse leak than anything this page is demonstrating.
 */
export const curlFor = (endpoint: EndpointSpec, url: string, body: string | null): string => {
  const lines = [`curl -s -X ${endpoint.method} '${url}'`, `  -H "Authorization: Bearer $KEY"`];
  if (body === null) return lines.join(" \\\n");
  return [...lines, `  -H 'Content-Type: application/json'`, `  -d '${body.replace(/\s+/g, " ").trim()}'`].join(" \\\n");
};
