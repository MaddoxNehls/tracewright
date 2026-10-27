import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, HttpExporter, init, instrumentAnthropic, run, shutdown, span, stats, trace } from "../src/index.ts";
import { InMemoryExporter } from "../src/testing.ts";

const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"accepted":1}', { status: 202 }));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TRACEWRIGHT_API_KEY", "");
  vi.stubEnv("TRACEWRIGHT_ENDPOINT", "");
  fetchMock.mockClear();
});

afterEach(async () => {
  await shutdown();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("no-op mode", () => {
  it("runs instrumented code unchanged and sends nothing without an API key", async () => {
    init();
    const tool = trace(async (x: number) => x * 2, { kind: "tool" });
    const client = instrumentAnthropic({ messages: { create: async () => ({ content: [] }) } });

    const result = await run("agent", async () => {
      await client.messages.create();
      return span("step", () => tool(21));
    });

    expect(result).toBe(42);
    expect(await flush()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stats()).toEqual({ exported: 0, droppedQueueFull: 0, failed: 0 });
  });

  it("is the default before init is ever called", async () => {
    await shutdown();
    expect(run("agent", () => "still works")).toBe("still works");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still rethrows errors from host code", () => {
    init();
    expect(() =>
      run("agent", () => {
        throw new Error("host bug");
      }),
    ).toThrow("host bug");
  });
});

describe("init", () => {
  it("reads TRACEWRIGHT_API_KEY and TRACEWRIGHT_ENDPOINT", async () => {
    vi.stubEnv("TRACEWRIGHT_API_KEY", "tw_from_env");
    vi.stubEnv("TRACEWRIGHT_ENDPOINT", "https://ingest.example.com");
    init();

    run("agent", () => undefined);
    expect(await flush()).toBe(true);

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://ingest.example.com/v1/spans");
    expect(request?.headers).toMatchObject({ authorization: "Bearer tw_from_env" });
    expect(stats().exported).toBe(1);
  });

  it("defaults the endpoint to localhost:4318 and prefers explicit options", async () => {
    vi.stubEnv("TRACEWRIGHT_API_KEY", "tw_from_env");
    init({ apiKey: "tw_explicit" });

    run("agent", () => undefined);
    await flush();

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:4318/v1/spans");
    expect(request?.headers).toMatchObject({ authorization: "Bearer tw_explicit" });
  });

  it("flushes the previous exporter when re-initialised", async () => {
    const shutdownSpy = vi.spyOn(HttpExporter.prototype, "shutdown");
    init({ apiKey: "tw_first" });
    run("first", () => undefined);

    const recorder = new InMemoryExporter();
    init({ exporter: recorder });
    run("second", () => undefined);

    expect(shutdownSpy).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(recorder.spans.map((s) => s.name)).toEqual(["second"]);
  });

  it("swallows failures from a misbehaving custom exporter", async () => {
    const broken = new InMemoryExporter();
    broken.export = () => {
      throw new Error("exporter bug");
    };
    broken.flush = () => Promise.reject(new Error("flush bug"));
    init({ exporter: broken });

    expect(run("agent", () => "ok")).toBe("ok");
    expect(await flush()).toBe(false);
  });
});
