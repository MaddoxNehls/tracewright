"use client";

/** Last-resort boundary for errors in the root layout itself. It replaces <html>, so it can't rely on app styles. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: "#0b0e13", color: "#e6eaf0", fontFamily: "system-ui, sans-serif", padding: "64px 24px" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Tracewright hit an unexpected error</h1>
        <p style={{ color: "#9aa4b4", fontSize: 14 }}>Reload the page. If it keeps happening, the server logs have the details.</p>
        <button type="button" onClick={reset} style={{ marginTop: 12, padding: "8px 16px", borderRadius: 6, border: "1px solid #2c3542", background: "transparent", color: "inherit" }}>
          Reload
        </button>
      </body>
    </html>
  );
}
