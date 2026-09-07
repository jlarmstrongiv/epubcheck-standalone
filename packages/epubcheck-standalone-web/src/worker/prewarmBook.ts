// A tiny, fully valid EPUB embedded as base64, used ONLY to pre-warm the
// worker's engine on page load (see useEpubcheck.ts prewarm). Validating it
// runs the library's engine main() once to a CLEAN completion, so the reused
// runtime scope is cached warm in the worker's module state — the user's first
// File/directory validation then hits the warm path (tens of ms) instead of the
// ~5-8 s cold engine parse.
//
// Origin: this is byte-for-byte the demo's own `public/fixtures/test.epub`
// (1729 bytes), which is byte-identical to the library's
// `test/fixtures/test.epub` — the canonical 1.7 KB clean-pass fixture. Verified
// clean: validate() returns valid, exitCode 0, zero messages (so main()
// completes normally and the scope qualifies for reuse per the driver rule
// "only a scope whose main() completed normally is cached"). It is embedded
// (not fetched) so the warm-up needs no network round trip and cannot be
// delayed or defeated by the page's base path.

export const PREWARM_BOOK_NAME = "prewarm.epub";

// Base64 of the 1729-byte test.epub. Kept as one constant to stay small.
const PREWARM_BOOK_BASE64 =
  "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";

// Decode the embedded base64 to raw bytes. Runs on the main thread where `atob`
// exists; the bytes are handed to a File and posted to the worker for validate.
export function prewarmBookBytes(): Uint8Array<ArrayBuffer> {
  const binary = atob(PREWARM_BOOK_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
