/** Internal diagnostics. Warnings flag lost data; debug output is opt-in via TRACEWRIGHT_DEBUG. */

const PREFIX = "[tracewright]";

export const log = {
  warn(message: string, error?: unknown): void {
    console.warn(PREFIX, message, ...(error === undefined ? [] : [error]));
  },
  debug(message: string, error?: unknown): void {
    if (process.env["TRACEWRIGHT_DEBUG"]) {
      console.debug(PREFIX, message, ...(error === undefined ? [] : [error]));
    }
  },
};
