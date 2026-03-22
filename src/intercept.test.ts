import { describe, it, expect, vi } from "vitest";
import { createInterceptor } from "./intercept.js";
import type { Page } from "puppeteer-core";

/**
 * Creates a minimal Page mock that captures the function registered via
 * exposeFunction so tests can simulate what the browser would call when
 * it intercepts a matching network request.
 */
function mockPage() {
  let captureCallback: ((id: string, dataJson: string) => void) | undefined;

  const page = {
    exposeFunction: vi.fn(async (_name: string, fn: (id: string, dataJson: string) => void) => {
      captureCallback = fn;
    }),
    evaluateOnNewDocument: vi.fn(async () => {}),
  } as unknown as Page;

  function simulateCapture(id: string, data: unknown) {
    captureCallback?.(id, JSON.stringify(data));
  }

  return { page, simulateCapture };
}

describe("createInterceptor", () => {
  it("calls exposeFunction and evaluateOnNewDocument on the page", async () => {
    const { page } = mockPage();
    await createInterceptor(page, [{ id: "test", urlPrefix: "https://api.example.com" }]);
    expect(page.exposeFunction).toHaveBeenCalledWith("__obcCapture", expect.any(Function));
    expect(page.evaluateOnNewDocument).toHaveBeenCalledOnce();
  });

  it("getAll returns empty array before any capture", async () => {
    const { page } = mockPage();
    const interceptor = await createInterceptor(page, [{ id: "foo", urlPrefix: "https://x.com" }]);
    expect(interceptor.getAll("foo")).toEqual([]);
    expect(interceptor.getAll("unknown")).toEqual([]);
  });

  it("getAll returns captured data after a simulated browser capture", async () => {
    const { page, simulateCapture } = mockPage();
    const interceptor = await createInterceptor(page, [{ id: "acct", urlPrefix: "https://bank.cl/api" }]);

    const payload = { movements: [{ amount: "1000", date: "2026-01-01" }] };
    simulateCapture("acct", payload);

    expect(interceptor.getAll("acct")).toEqual([payload]);
  });

  it("accumulates multiple captures for the same endpoint", async () => {
    const { page, simulateCapture } = mockPage();
    const interceptor = await createInterceptor(page, [{ id: "ep", urlPrefix: "https://bank.cl" }]);

    simulateCapture("ep", { page: 1 });
    simulateCapture("ep", { page: 2 });

    expect(interceptor.getAll("ep")).toHaveLength(2);
  });

  it("isolates captures by endpoint id", async () => {
    const { page, simulateCapture } = mockPage();
    const interceptor = await createInterceptor(page, [
      { id: "checking", urlPrefix: "https://bank.cl/checking" },
      { id: "cc", urlPrefix: "https://bank.cl/cards" },
    ]);

    simulateCapture("checking", { movements: [] });

    expect(interceptor.getAll("checking")).toHaveLength(1);
    expect(interceptor.getAll("cc")).toHaveLength(0);
  });

  it("waitFor resolves immediately when data is already captured", async () => {
    const { page, simulateCapture } = mockPage();
    const interceptor = await createInterceptor(page, [{ id: "fast", urlPrefix: "https://x.cl" }]);

    simulateCapture("fast", { ok: true });
    const result = await interceptor.waitFor("fast");
    expect(result).toEqual([{ ok: true }]);
  });

  it("waitFor resolves when data arrives before the timeout", async () => {
    const { page, simulateCapture } = mockPage();
    const interceptor = await createInterceptor(page, [{ id: "delayed", urlPrefix: "https://x.cl" }]);

    // Simulate capture arriving after a short delay
    setTimeout(() => simulateCapture("delayed", { value: 42 }), 50);

    const result = await interceptor.waitFor("delayed", 500);
    expect(result).toEqual([{ value: 42 }]);
  });

  it("waitFor returns empty array when timeout expires with no data", async () => {
    const { page } = mockPage();
    const interceptor = await createInterceptor(page, [{ id: "slow", urlPrefix: "https://x.cl" }]);

    const result = await interceptor.waitFor("slow", 100);
    expect(result).toEqual([]);
  });

  it("ignores malformed JSON from the browser bridge", async () => {
    const { page } = mockPage();
    let captureCallback: ((id: string, dataJson: string) => void) | undefined;
    (page.exposeFunction as ReturnType<typeof vi.fn>).mockImplementation(
      async (_name: string, fn: (id: string, dataJson: string) => void) => {
        captureCallback = fn;
      },
    );
    const interceptor = await createInterceptor(page, [{ id: "ep", urlPrefix: "https://x.cl" }]);

    // Should not throw
    captureCallback?.("ep", "{ invalid json }}}");

    expect(interceptor.getAll("ep")).toEqual([]);
  });
});
