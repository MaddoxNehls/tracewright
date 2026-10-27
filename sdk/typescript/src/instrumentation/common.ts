/** Shared machinery for wrapping an LLM client's `create` method in `llm` spans. */

import { log } from "../log.ts";
import type { Span } from "../span.ts";
import { isPromiseLike, startSpan } from "../tracer.ts";

const INSTRUMENTED = Symbol.for("tracewright.instrumented");

/** Any function; `never[]` parameters accept every signature, including SDK overloads. */
export type AnyFunction = (...args: never[]) => unknown;

type Callable = (this: unknown, ...args: unknown[]) => unknown;

export interface RequestInfo {
  name: string;
  attributes: Record<string, unknown>;
  input: unknown;
}

/** Translates one provider's request/response shapes into span data. */
export interface LlmAdapter {
  describeRequest(params: Readonly<Record<string, unknown>>): RequestInfo;
  recordResponse(span: Span, response: unknown): void;
}

/**
 * Replace `owner.create` with a traced wrapper. Idempotent.
 *
 * Adapter errors are logged and swallowed: a bug in tracing must never change what the
 * host's LLM call returns or throws.
 */
export function patchCreate(owner: { create: AnyFunction }, adapter: LlmAdapter): void {
  const original = owner.create as unknown as Callable;
  if (typeof original !== "function" || INSTRUMENTED in original) return;

  function create(this: unknown, ...args: unknown[]): unknown {
    const params = isRecord(args[0]) ? args[0] : {};
    // TODO: instrument streaming responses; until then they pass through untraced.
    if (params["stream"]) return original.apply(this, args);

    const llmSpan = openSpan(adapter, params);
    const finish = (response: unknown): void => {
      try {
        adapter.recordResponse(llmSpan, response);
      } catch (error) {
        log.debug("failed to record LLM response", error);
      }
      llmSpan.end();
    };
    const fail = (error: unknown): void => {
      llmSpan.recordException(error);
      llmSpan.end();
    };

    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (error) {
      fail(error);
      throw error;
    }
    if (isPromiseLike(result)) {
      // Observe the outcome on a side chain and return the SDK's own promise untouched:
      // its APIPromise carries extras such as withResponse() that a wrapper would lose.
      // The rejection handler also keeps the side chain from going unhandled.
      result.then(finish, fail);
    } else {
      finish(result);
    }
    return result;
  }

  Object.defineProperty(create, INSTRUMENTED, { value: true });
  owner.create = create;
}

function openSpan(adapter: LlmAdapter, params: Readonly<Record<string, unknown>>): Span {
  let info: RequestInfo;
  try {
    info = adapter.describeRequest(params);
  } catch (error) {
    log.debug("failed to describe LLM request", error);
    info = { name: "chat", attributes: {}, input: null };
  }
  return startSpan(info.name, "llm", { input: info.input, attributes: info.attributes });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function read(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

export function readString(source: unknown, key: string): string | undefined {
  const value = read(source, key);
  return typeof value === "string" ? value : undefined;
}

export function readNumber(source: unknown, key: string): number | undefined {
  const value = read(source, key);
  return typeof value === "number" ? value : undefined;
}

/** Drop undefined entries so absent fields are omitted rather than recorded as null. */
export function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export function chatSpanName(model: string | undefined): string {
  return model ? `chat ${model}` : "chat";
}
