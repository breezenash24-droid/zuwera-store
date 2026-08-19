/**
 * Cloudflare Workers globals that the WebWorker lib does not declare.
 *
 * jsconfig.json already sets `lib: ["ES2022", "WebWorker"]`, which covers fetch,
 * Request, Response and crypto. HTMLRewriter is Cloudflare's own — it exists at
 * runtime on every Pages Function and nowhere in any standard lib, so without
 * this the typecheck reports an undeclared name for a global that is genuinely
 * there.
 *
 * Declared rather than silenced. The whole point of the typecheck is to catch
 * "this name does not exist"; the fix for a name that DOES exist is to say so,
 * not to turn the check off for the file and lose it for every other name in
 * there too.
 *
 * Deliberately minimal: only the surface functions/_middleware.js uses. A fuller
 * set belongs in @cloudflare/workers-types, which is a dependency this repo does
 * not otherwise need.
 */

interface HTMLRewriterElement {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
}

interface HTMLRewriterElementHandler {
  element?(element: HTMLRewriterElement): void | Promise<void>;
}

declare class HTMLRewriter {
  on(selector: string, handler: HTMLRewriterElementHandler): HTMLRewriter;
  transform(response: Response): Response;
}
