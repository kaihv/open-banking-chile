import type { Page } from "puppeteer-core";

export interface EndpointConfig {
  /** Unique identifier used to retrieve captured data */
  id: string;
  /** URL prefix — any request whose URL starts with this string is captured */
  urlPrefix: string;
}

export interface Interceptor {
  /** Returns all captured response bodies for the given endpoint id */
  getAll(id: string): unknown[];
  /**
   * Waits until at least one response has been captured for the given endpoint id.
   * Returns the captured responses, or an empty array if the timeout is reached.
   */
  waitFor(id: string, timeoutMs?: number): Promise<unknown[]>;
}

/**
 * Installs fetch() and XMLHttpRequest interception on the page.
 *
 * Must be called BEFORE page.goto() because it uses:
 *   - page.exposeFunction  — makes a Node.js callback available as window.__obcCapture
 *   - page.evaluateOnNewDocument — installs the wrappers in every new document
 *
 * When a monitored URL is requested by the page, the response JSON is forwarded
 * to Node.js and stored keyed by endpoint id.
 */
export async function createInterceptor(
  page: Page,
  endpoints: EndpointConfig[],
): Promise<Interceptor> {
  const captures = new Map<string, unknown[]>();

  // Bridge: called from browser context → stores data in Node.js
  await page.exposeFunction(
    "__obcCapture",
    (id: string, dataJson: string) => {
      try {
        const data: unknown = JSON.parse(dataJson);
        const existing = captures.get(id) ?? [];
        existing.push(data);
        captures.set(id, existing);
      } catch {
        // Ignore malformed JSON
      }
    },
  );

  // Inject the fetch/XHR wrappers before any document loads
  await page.evaluateOnNewDocument(
    (endpointsJson: string) => {
      const eps = JSON.parse(endpointsJson) as Array<{ id: string; urlPrefix: string }>;

      function matchEndpoint(url: string): { id: string; urlPrefix: string } | undefined {
        return eps.find((e) => url.startsWith(e.urlPrefix));
      }

      function capture(id: string, data: unknown): void {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__obcCapture(id, JSON.stringify(data));
        } catch {
          // Bridge not yet ready — ignore
        }
      }

      // ── Wrap fetch ──────────────────────────────────────────────
      const originalFetch = window.fetch;
      window.fetch = async function (...args: Parameters<typeof fetch>): Promise<Response> {
        const url =
          typeof args[0] === "string"
            ? args[0]
            : args[0] instanceof Request
              ? args[0].url
              : String(args[0]);

        const ep = matchEndpoint(url);
        const response = await originalFetch.apply(window, args);

        if (ep) {
          response
            .clone()
            .json()
            .then((data: unknown) => capture(ep.id, data))
            .catch(() => {});
        }

        return response;
      };

      // ── Wrap XHR ────────────────────────────────────────────────
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        ...rest: [boolean?, string?, string?]
      ): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).__obcEp = matchEndpoint(String(url));
        return origOpen.apply(this, [method, url, ...rest] as Parameters<typeof origOpen>);
      };

      XMLHttpRequest.prototype.send = function (
        ...args: Parameters<typeof origSend>
      ): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ep = (this as any).__obcEp as { id: string } | undefined;
        if (ep) {
          this.addEventListener("load", function (this: XMLHttpRequest) {
            try {
              const data: unknown =
                this.responseType === "json"
                  ? this.response
                  : (JSON.parse(this.responseText) as unknown);
              capture(ep.id, data);
            } catch {
              // Ignore parse errors
            }
          });
        }
        return origSend.apply(this, args);
      };
    },
    JSON.stringify(endpoints),
  );

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    getAll(id: string): unknown[] {
      return captures.get(id) ?? [];
    },

    async waitFor(id: string, timeoutMs = 10_000): Promise<unknown[]> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const data = captures.get(id);
        if (data && data.length > 0) return data;
        await sleep(200);
      }
      return captures.get(id) ?? [];
    },
  };
}
