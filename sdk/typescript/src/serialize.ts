/** Conversion of arbitrary JS values into JSON-safe snapshots, plus payload truncation. */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_DEPTH = 32;
const TRUNCATION_MARKER = "...[truncated by tracewright]";

/**
 * Return a deep, JSON-safe copy of `value`. Never throws.
 *
 * Because the result is a copy, later mutation of the original (an agent appending to its
 * message history, say) does not change what was recorded. Circular references become
 * `"[Circular]"`; shared but acyclic references are copied normally.
 */
export function toJsonable(value: unknown): JsonValue {
  return convert(value, new Set<object>(), 0);
}

function convert(value: unknown, ancestors: Set<object>, depth: number): JsonValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "undefined":
      return null;
    case "symbol":
      return value.toString();
    case "function":
      return `[Function ${value.name || "anonymous"}]`;
  }
  if (value === null) return null;

  const obj = value as object;
  if (ancestors.has(obj)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[MaxDepth]";

  ancestors.add(obj);
  try {
    return convertObject(obj, ancestors, depth + 1);
  } catch {
    return describe(obj);
  } finally {
    ancestors.delete(obj);
  }
}

function convertObject(obj: object, ancestors: Set<object>, depth: number): JsonValue {
  const recurse = (v: unknown): JsonValue => convert(v, ancestors, depth);

  if (obj instanceof Error) {
    const error: { [key: string]: JsonValue } = { type: obj.name, message: obj.message };
    if (obj.stack !== undefined) error["stack"] = obj.stack;
    if (obj.cause !== undefined) error["cause"] = recurse(obj.cause);
    return error;
  }
  if (Array.isArray(obj)) return obj.map(recurse);
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  if (obj instanceof Map) {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of obj) out[String(k)] = recurse(v);
    return out;
  }
  if (obj instanceof Set) return Array.from(obj, recurse);
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return `<${obj.byteLength} bytes>`;
  if (obj instanceof Promise) return "[Promise]";

  // Honour toJSON (as JSON.stringify would); SDK response objects and URLs rely on it.
  const toJSON = (obj as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") return recurse(toJSON.call(obj));

  const out: { [key: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = recurse(v);
  }
  return out;
}

function describe(obj: object): string {
  try {
    return `[${obj.constructor?.name ?? "Object"}]`;
  } catch {
    return "[Unserializable]";
  }
}

/**
 * Cap the serialized size of a JSON-safe payload.
 *
 * Oversized payloads become a string holding a prefix of their JSON encoding, so the
 * recorded span stays readable in the dashboard.
 */
export function truncatePayload(
  value: JsonValue,
  limit: number = MAX_PAYLOAD_BYTES,
): { value: JsonValue; truncated: boolean } {
  if (value === null) return { value, truncated: false };
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.byteLength <= limit) return { value, truncated: false };

  const budget = Math.max(limit - Buffer.byteLength(TRUNCATION_MARKER), 0);
  // Cutting at a byte offset can split a multi-byte character; drop the replacement char.
  const head = encoded.subarray(0, budget).toString("utf8").replace(/�$/, "");
  return { value: head + TRUNCATION_MARKER, truncated: true };
}
