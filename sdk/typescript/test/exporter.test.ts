import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRetryAfter } from "../src/exporter.ts";
import { HttpExporter, type HttpExporterOptions, Span, type SpanRecord } from "../src/index.ts";
import { newTraceId } from "../src/span.ts";

function finishedSpan(name = "step"): Span {
  const span = new Span({ name, kind: "custom", traceId: newTraceId(), parentSpanId: null, onEnd: () => {} });
  span.end();
  return span;
}

function respond(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 202 ? '{"accepted":1}' : "{}", { status, headers });
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function sentSpans(fetchMock: FetchMock, call = 0): SpanRecord[] {
  const init = fetchMock.mock.calls[call]?.[1];
  const body = gunzipSync(init?.body as Uint8Array).toString("utf8");
  return (JSON.parse(body) as { spans: SpanRecord[] }).spans;
}

function makeExporter(fetchMock: FetchMock, options: Partial<HttpExporterOptions> = {}) {
  const sleep = vi.fn((_ms: number) => Promise.resolve());
  const exporter = new HttpExporter({ apiKey: "tw_test", fetch: fetchMock, sleep, ...options });
  return { exporter, sleep };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("HttpExporter batching", () => {
  it("splits the queue into batches of batchSize", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => respond(202));
    const { exporter } = makeExporter(fetchMock, { batchSize: 100 });

    for (let i = 0; i < 250; i++) exporter.export(finishedSpan(`s${i}`));
    expect(await exporter.flush()).toBe(true);

    expect(fetchMock.mock.calls.map((_, i) => sentSpans(fetchMock, i).length)).toEqual([100, 100, 50]);
    expect(exporter.stats).toEqual({ exported: 250, droppedQueueFull: 0, failed: 0 });
  });

  it("posts gzipped JSON with bearer auth to /v1/spans", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => respond(202));
    const { exporter } = makeExporter(fetchMock, { endpoint: "https://ingest.example.com/" });

    exporter.export(finishedSpan("hello"));
    await exporter.flush();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://ingest.example.com/v1/spans");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer tw_test",
      "content-type": "application/json",
      "content-encoding": "gzip",
    });
    expect(sentSpans(fetchMock)[0]?.name).toBe("hello");
  });

  it("sends a partial batch once the flush interval elapses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => respond(202));
    const { exporter } = makeExporter(fetchMock, { flushIntervalMs: 10 });

    exporter.export(finishedSpan());
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exporter.stats.exported).toBe(1));
  });
});

describe("HttpExporter retries", () => {
  it("retries 503 with backoff, then succeeds", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(respond(503)).mockResolvedValueOnce(respond(202));
    const { exporter, sleep } = makeExporter(fetchMock, { backoffBaseMs: 100 });

    exporter.export(finishedSpan());
    expect(await exporter.flush()).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(0);
    expect(sleep.mock.calls[0]?.[0]).toBeLessThanOrEqual(100);
    expect(exporter.stats.exported).toBe(1);
  });

  it("honours Retry-After on 429", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(respond(429, { "Retry-After": "2" }))
      .mockResolvedValueOnce(respond(202));
    const { exporter, sleep } = makeExporter(fetchMock);

    exporter.export(finishedSpan());
    await exporter.flush();

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(exporter.stats.exported).toBe(1);
  });

  it("retries network errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(respond(202));
    const { exporter } = makeExporter(fetchMock);

    exporter.export(finishedSpan());
    await exporter.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(exporter.stats.exported).toBe(1);
  });

  it("uses exponentially growing backoff and gives up after maxRetries", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => respond(500));
    const { exporter, sleep } = makeExporter(fetchMock, { maxRetries: 3, backoffBaseMs: 100 });
    vi.spyOn(Math, "random").mockReturnValue(1);

    exporter.export(finishedSpan());
    await exporter.flush();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400]);
    expect(exporter.stats).toEqual({ exported: 0, droppedQueueFull: 0, failed: 1 });
  });

  it("does not retry other 4xx responses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => respond(400));
    const { exporter, sleep } = makeExporter(fetchMock);

    exporter.export(finishedSpan());
    await exporter.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(exporter.stats.failed).toBe(1);
    expect(console.warn).toHaveBeenCalledWith("[tracewright]", expect.stringContaining("HTTP 400"));
  });
});

describe("HttpExporter resilience", () => {
  it("drops and counts spans when the buffer is full", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => respond(202));
    const { exporter } = makeExporter(fetchMock, { maxQueueSize: 5 });

    for (let i = 0; i < 8; i++) exporter.export(finishedSpan());
    await exporter.flush();

    expect(exporter.stats).toEqual({ exported: 5, droppedQueueFull: 3, failed: 0 });
  });

  it("never throws into the host, even when fetch throws synchronously", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => {
      throw new Error("synchronous fetch failure");
    });
    const { exporter } = makeExporter(fetchMock, { maxRetries: 1 });

    expect(() => exporter.export(finishedSpan())).not.toThrow();
    await expect(exporter.flush()).resolves.toBe(true);
    expect(exporter.stats.failed).toBe(1);
  });

  it("skips an unserializable span without losing the rest of the batch", async () => {
    class BrokenSpan extends Span {
      override toJSON(): SpanRecord {
        throw new Error("cannot serialize");
      }
    }
    const broken = new BrokenSpan({
      name: "broken",
      kind: "custom",
      traceId: newTraceId(),
      parentSpanId: null,
      onEnd: () => {},
    });
    const fetchMock = vi.fn<typeof fetch>(async () => respond(202));
    const { exporter } = makeExporter(fetchMock);

    exporter.export(broken);
    exporter.export(finishedSpan("good"));
    await exporter.flush();

    expect(sentSpans(fetchMock).map((s) => s.name)).toEqual(["good"]);
    expect(exporter.stats).toEqual({ exported: 1, droppedQueueFull: 0, failed: 1 });
  });

  it("returns false when flush times out", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const { exporter } = makeExporter(fetchMock);

    exporter.export(finishedSpan());
    expect(await exporter.flush(20)).toBe(false);
  });

  it("stops accepting spans after shutdown", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => respond(202));
    const { exporter } = makeExporter(fetchMock);

    exporter.export(finishedSpan());
    await exporter.shutdown();
    exporter.export(finishedSpan());
    await exporter.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(exporter.stats.exported).toBe(1);
  });
});

describe("parseRetryAfter", () => {
  it("accepts delta-seconds and HTTP-dates, capped and floored", () => {
    expect(parseRetryAfter("1.5", 30_000)).toBe(1500);
    expect(parseRetryAfter("999", 30_000)).toBe(30_000);
    expect(parseRetryAfter("-3", 30_000)).toBe(0);
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect(parseRetryAfter(inTenSeconds, 30_000)).toBeGreaterThan(8000);
  });

  it("ignores missing or malformed values", () => {
    expect(parseRetryAfter(null, 30_000)).toBeUndefined();
    expect(parseRetryAfter("", 30_000)).toBeUndefined();
    expect(parseRetryAfter("soon", 30_000)).toBeUndefined();
  });
});

interface Received {
  headers: IncomingMessage["headers"];
  spans: SpanRecord[];
}

/** A stand-in ingest service that accepts every batch and records what it decoded. */
async function startIngest(): Promise<{ endpoint: string; received: Received[]; close: () => void }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8")) as { spans: SpanRecord[] };
      received.push({ headers: req.headers, spans: body.spans });
      res.writeHead(202, { "content-type": "application/json" }).end(`{"accepted":${body.spans.length}}`);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, received, close: () => server.close() };
}

describe("HttpExporter over real HTTP", () => {
  it("delivers a gzipped batch that a node:http server can decode", async () => {
    const ingest = await startIngest();
    try {
      const exporter = new HttpExporter({ apiKey: "tw_real", endpoint: ingest.endpoint });
      exporter.export(finishedSpan("one"));
      exporter.export(finishedSpan("two"));
      expect(await exporter.flush()).toBe(true);

      expect(ingest.received).toHaveLength(1);
      expect(ingest.received[0]?.headers.authorization).toBe("Bearer tw_real");
      expect(ingest.received[0]?.spans.map((s) => s.name)).toEqual(["one", "two"]);
    } finally {
      ingest.close();
    }
  });
});

describe("process lifetime", () => {
  // Runs the TypeScript source directly in a child Node process (built-in type stripping).
  async function runScript(body: string): Promise<{ code: number | null; elapsedMs: number }> {
    const dir = mkdtempSync(join(tmpdir(), "tracewright-"));
    const file = join(dir, "script.mjs");
    const entry = pathToFileURL(resolve(import.meta.dirname, "../src/index.ts")).href;
    writeFileSync(file, `import * as tw from ${JSON.stringify(entry)};\n${body}`);
    const started = Date.now();
    const child = spawn(process.execPath, [file], { stdio: "ignore", timeout: 15_000 });
    const code = await new Promise<number | null>((done) => child.on("exit", done));
    return { code, elapsedMs: Date.now() - started };
  }

  it("does not keep an idle process alive", async () => {
    const { code, elapsedMs } = await runScript(
      `tw.init({ apiKey: "tw_x", endpoint: "http://127.0.0.1:9", flushIntervalMs: 60_000 });`,
    );
    expect(code).toBe(0);
    expect(elapsedMs).toBeLessThan(3000);
  });

  it("flushes pending spans on natural exit without an explicit flush()", async () => {
    const ingest = await startIngest();
    try {
      const { code } = await runScript(
        `tw.init({ apiKey: "tw_x", endpoint: ${JSON.stringify(ingest.endpoint)}, flushIntervalMs: 60_000 });
         await tw.run("exit-flushed", async () => "done");`,
      );
      expect(code).toBe(0);
      expect(ingest.received.flatMap((r) => r.spans).map((s) => s.name)).toEqual(["exit-flushed"]);
    } finally {
      ingest.close();
    }
  }, 20_000);

  it("bounds the exit-time flush when ingest is unreachable", async () => {
    const { code, elapsedMs } = await runScript(
      `tw.init({ apiKey: "tw_x", endpoint: "http://127.0.0.1:9", flushIntervalMs: 60_000 });
       tw.run("unsent", () => 1);`,
    );
    expect(code).toBe(0);
    // The exit flush is capped at 2 s; the rest is Node startup headroom.
    expect(elapsedMs).toBeLessThan(6000);
  }, 20_000);
});
