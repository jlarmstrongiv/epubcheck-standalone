package ecshim;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.UnknownHostException;

import org.teavm.interop.Async;
import org.teavm.interop.AsyncCallback;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSFunctor;
import org.teavm.jso.JSObject;
import org.teavm.jso.typedarrays.Int8Array;

/**
 * Java-side view of an http(s) DOWNLOAD performed by the JS host, feeding
 * epubcheck's URL-input path ({@code epubcheck https://host/book.epub}). This
 * is the TeaVM descendant of the wasm-era build/wrapper/JsHttpFeed.java (kept
 * in the tree as reference). The JS host installs, for a URL run only:
 *
 *   globalThis.__epubHttpGet(url, done)          -&gt; void (async)
 *       start a PLAIN ASYNC GET on the host (fetch -- no worker threads, no
 *       SharedArrayBuffer, no sync XHR; see http-bridge.ts) and call
 *       {@code done(response)} EXACTLY ONCE, from a later task or microtask
 *       (never re-entrantly inside the __epubHttpGet call itself), with the
 *       NUL-joined response string:
 *         "S" NUL status NUL handle NUL byteLength     response received
 *         "E" NUL kind   NUL message                   network-level failure,
 *                                                      kind: connect | unknownhost | io
 *       The Java green thread SUSPENDS at {@link #httpGet} (TeaVM
 *       {@code @Async} native suspend/resume) while the host downloads, and
 *       resumes when {@code done} fires -- the host event loop stays free for
 *       the whole download, which is what lets an in-process server answer
 *       and lets the browser run URL inputs on its MAIN thread.
 *   globalThis.__epubHttpRead(target, handle, offset, length) -&gt; count
 *       fill `target` (an Int8Array view over the requesting Java byte[],
 *       passed by reference like HostBook's __ecRead) with EXACTLY the body
 *       bytes [offset, offset+length) of that response; return the count
 *       EITHER synchronously (a number -- the fast path, e.g. an in-memory
 *       browser body) OR as a thenable resolving to it (an async host read --
 *       e.g. Node's promise-API read off the disk spool). On a thenable the
 *       Java green thread SUSPENDS at {@link #feedReadAwait} (the exact
 *       {@code @Async} seam contract HostBook's __ecRead uses, with the same
 *       pending/threw sentinels and stashes) and resumes when it settles; a
 *       synchronous count never touches the pause machinery. Reads are at
 *       most 8 MiB per call ({@link #MAX_JS_CALL_BYTES}, and HostBook's
 *       httpMode pulls whole 8 MiB blocks), so a suspension can happen at
 *       most once per 8 MiB, never per engine read.
 *
 * The NUL-joined header transport is the same one __epubArgs uses (string-only
 * interop; NUL can occur in none of the joined tokens). The RANGE transport is
 * a typed-array fill (the wasm era used base64 because GraalVM's interop was
 * string-only; TeaVM passes byte[] backing stores by reference).
 *
 * WHERE IT PLUGS IN: the ONLY http(s) opening the stock checker performs goes
 * through com.adobe.epubcheck.util.URLResourceProvider.openStream (the CLI's
 * URL input branch via EpubCheckFactory, the single-file --mode URL checks,
 * and the ValidationContext fallback provider chain). The shim-jar shadow of
 * exactly that class (../com/adobe/epubcheck/util/URLResourceProvider.java)
 * reroutes http(s) opens to {@link #open}, so URL naming in reported messages
 * and all downstream handling stay the stock code's. The shadowed
 * EpubCheck(InputStream, ...) constructor then recognizes the returned
 * {@link BodyStream} and registers the body with {@link HostBook} instead of
 * copying it into the in-memory VFS -- which is what removes the wasm era's
 * whole-body-in-VFS size cap: the book is range-read off the bridge exactly
 * like a host range-fed local book.
 *
 * EXCEPTION PARITY: {@link #open} throws exactly what java.net.URL.openStream
 * (HttpURLConnection.getInputStream) throws on the jar side, so the CLI's
 * failure output keeps the jar's headline wording:
 *   404/410            java.io.FileNotFoundException: &lt;url&gt;
 *   other &gt;= 400 codes java.io.IOException: Server returned HTTP response
 *                      code: &lt;status&gt; for URL: &lt;url&gt;
 *   connect kind       java.net.ConnectException: &lt;message&gt;
 *   unknownhost kind   java.net.UnknownHostException: &lt;message&gt;
 *   io kind            java.io.IOException: &lt;message&gt;
 * Stack trace FRAMES below the headline differ from the jar's (different
 * runtime internals); the headline and cause lines are the pinned contract.
 *
 * REDIRECTS: the JS fetch/XHR side follows redirects before reporting the
 * final status, matching HttpURLConnection's default same-protocol following.
 * (A protocol-switching http-&gt;https redirect is followed here but not by
 * the jar, which stops at the 3xx response -- the one documented divergence.)
 */
public final class HostHttp {

    /** Same per-JS-call bound as the other feeds (HostBook's block size). */
    private static final int MAX_JS_CALL_BYTES = 8 << 20;

    private HostHttp() {
    }

    @JSBody(script = "return (typeof globalThis.__epubHttpGet === 'function'"
            + " && typeof globalThis.__epubHttpRead === 'function');")
    private static native boolean hasFeed();

    /**
     * The JS completion callback the host invokes when its GET finishes:
     * one call, with the NUL-joined response string (see the class comment).
     */
    @JSFunctor
    public interface HttpDone extends JSObject {
        void done(String response);
    }

    @JSBody(params = { "url", "done" }, script = "globalThis.__epubHttpGet(url, done);")
    private static native void httpGetStart(String url, HttpDone done);

    /**
     * TeaVM native suspend/resume seam: callers of this method (and their
     * whole call chain up from the entry point) are CPS-lowered by the
     * compiler; at run time the Java green thread SUSPENDS here while the
     * host performs the async GET and resumes with the response string when
     * the companion's callback completes.
     */
    @Async
    private static native String httpGet(String url);

    private static void httpGet(String url, final AsyncCallback<String> callback) {
        httpGetStart(url, response -> callback.complete(response));
    }

    /**
     * Sentinel {@link #feedReadTry} returns when the host answered with a
     * thenable instead of a count: the read is in flight and must be awaited
     * through {@link #feedReadAwait}. Same contract (and same value) as
     * HostBook.READ_PENDING -- distinct from every legal count (>= 0).
     */
    private static final int READ_PENDING = -2;

    /**
     * Sentinel {@link #feedReadTry} returns when the host's read function
     * THREW synchronously: the message is stashed in
     * globalThis.__epubHttpReadError (picked up -- and deleted -- by
     * {@link #takeReadError} in the same synchronous stretch) and
     * {@link #fill} rethrows it as an IOException carrying the RAW host
     * message, exactly like HostBook's READ_THREW path. Without this a sync
     * JS throw would cross the JSBody as a raw "java.lang.RuntimeException:
     * (JavaScript) ..." no catch(IOException) in epubcheck could handle.
     */
    private static final int READ_THREW = -3;

    /**
     * One synchronous call into the host's range read. A host that fills the
     * buffer synchronously returns the count and this is the WHOLE read (the
     * fast path). A host that returns a thenable gets it stashed in
     * globalThis.__epubHttpReadPending (picked up -- and deleted -- by
     * {@link #feedReadAwaitStart} in the SAME synchronous stretch, before the
     * fiber suspends, so nothing else can observe it) and the sentinel comes
     * back instead. A host that THROWS synchronously gets its message stashed
     * for {@link #takeReadError} and READ_THREW comes back. This is the exact
     * probe HostBook.feedReadTry / HostDir use for the book/directory feeds.
     */
    @JSBody(params = { "target", "handle", "offset", "count" },
            script = "var r;"
                + "try { r = globalThis.__epubHttpRead(target, handle, offset, count); }"
                + "catch (e) {"
                + "globalThis.__epubHttpReadError = String((e && e.message) || e);"
                + "return -3;"
                + "}"
                + "if (r !== null && typeof r === 'object' && typeof r.then === 'function') {"
                + "globalThis.__epubHttpReadPending = r;"
                + "return -2;"
                + "}"
                + "return r;")
    private static native int feedReadTry(Int8Array target, double handle, double offset, int count);

    /** Consume (and clear) the stashed sync-throw message of the last read. */
    @JSBody(script = "var m = globalThis.__epubHttpReadError;"
            + "delete globalThis.__epubHttpReadError;"
            + "return typeof m === 'string' ? m : 'host http range read failed';")
    private static native String takeReadError();

    /**
     * The JS completion callback wired onto the host's pending read promise:
     * called exactly once when it settles -- with (count, null) on success or
     * (-1, message) on rejection. Promise reactions always run from a later
     * microtask, never re-entrantly, the same non-reentrancy contract the
     * {@link HttpDone} download callback documents.
     */
    @JSFunctor
    public interface ReadDone extends JSObject {
        void done(int count, String error);
    }

    @JSBody(params = { "done" },
            script = "var p = globalThis.__epubHttpReadPending;"
                + "delete globalThis.__epubHttpReadPending;"
                + "p.then(function (n) { done(n | 0, null); },"
                + "function (e) { done(-1, String((e && e.message) || e)); });")
    private static native void feedReadAwaitStart(ReadDone done);

    /**
     * TeaVM native suspend/resume seam (the exact pattern of {@link #httpGet}
     * and HostBook.feedReadAwait): the Java green thread SUSPENDS here while
     * the host's async read fills the buffer, and resumes with the count when
     * the promise settles. Only ever called after feedReadTry returned
     * READ_PENDING, so a fully-synchronous host never suspends.
     */
    @Async
    private static native int feedReadAwait() throws IOException;

    private static void feedReadAwait(AsyncCallback<Integer> callback) {
        feedReadAwaitStart((count, error) -> {
            if (error != null) {
                callback.error(new IOException("host async http range read failed: " + error));
            } else {
                callback.complete(count);
            }
        });
    }

    static boolean isInstalled() {
        return hasFeed();
    }

    /**
     * Fill buf entirely with the body bytes [pos, pos + buf.length) of the
     * fetched response {@code handle}. Returns the count written (a short
     * count is the host reporting a failed/short range). May SUSPEND the Java
     * green thread when the host serves the range asynchronously (thenable
     * return); a synchronous host count completes in one plain JS call.
     */
    static int fill(double handle, long pos, byte[] buf) throws IOException {
        int got = feedReadTry(Int8Array.fromJavaArray(buf), handle, (double) pos, buf.length);
        if (got == READ_THREW) {
            // Sync host throw: surface the RAW host message as an IOException
            // epubcheck can handle (same conversion as HostBook/HostDir).
            throw new IOException(takeReadError());
        }
        if (got == READ_PENDING) {
            // Async host: suspend this green thread until the promise settles
            // (the host fills buf's backing Int8Array before resolving; the
            // byte[] does not move, so the view stays valid across the
            // suspension -- same guarantee as the book/directory feeds).
            got = feedReadAwait();
        }
        return got;
    }

    /**
     * Perform the GET through the JS host and return an InputStream over the
     * response body, throwing the same exceptions java.net.URL.openStream
     * would (see the class comment). The stream pulls the body in bounded
     * chunks of at most 8 MiB per JS call.
     */
    public static InputStream open(String url) throws IOException {
        if (!isInstalled()) {
            throw new IOException(
                "no JS http feed is installed (__epubHttpGet/__epubHttpRead) -- http(s) URL "
                    + "inputs need the host bridge (validate(await url(...)) installs it)");
        }
        String response = httpGet(url);
        if (response == null) {
            throw new IOException("__epubHttpGet returned null for " + url);
        }
        String[] parts = response.split("\u0000", -1);
        if (parts.length >= 3 && "E".equals(parts[0])) {
            String kind = parts[1];
            String message = parts[2];
            if ("connect".equals(kind)) {
                throw new ConnectException(message);
            }
            if ("unknownhost".equals(kind)) {
                throw new UnknownHostException(message);
            }
            throw new IOException(message);
        }
        if (parts.length != 4 || !"S".equals(parts[0])) {
            throw new IOException("__epubHttpGet returned a malformed response for " + url);
        }
        int status;
        long handle;
        long length;
        try {
            status = Integer.parseInt(parts[1]);
            handle = Long.parseLong(parts[2]);
            length = Long.parseLong(parts[3]);
        } catch (NumberFormatException e) {
            throw new IOException("__epubHttpGet returned a malformed response for " + url);
        }
        // Mirror HttpURLConnection.getInputStream's HTTP error mapping exactly
        // (it is what produces the jar's wording for these cases).
        if (status == 404 || status == 410) {
            throw new FileNotFoundException(url);
        }
        if (status >= 400) {
            throw new IOException("Server returned HTTP response code: " + status + " for URL: " + url);
        }
        return new BodyStream(handle, length);
    }

    /**
     * InputStream over one response body held by the JS host, pulled in
     * bounded chunks. The shadowed EpubCheck(InputStream, ...) constructor
     * recognizes this type and registers the body with {@link HostBook}
     * (random-access range reads) instead of copying the stream out.
     */
    public static final class BodyStream extends InputStream {
        private final long handle;
        private final long length;
        private long pos;

        BodyStream(long handle, long length) {
            this.handle = handle;
            this.length = length;
        }

        /** The host-side response handle (for HostBook registration). */
        public double handleId() {
            return (double) handle;
        }

        /** The response body's total size in bytes. */
        public long byteLength() {
            return length;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int n = read(one, 0, 1);
            return n <= 0 ? -1 : (one[0] & 0xff);
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) {
                return 0;
            }
            if (pos >= length) {
                return -1;
            }
            int want = (int) Math.min((long) Math.min(len, MAX_JS_CALL_BYTES), length - pos);
            byte[] chunk = new byte[want];
            int got = fill((double) handle, pos, chunk);
            if (got != want) {
                throw new IOException("__epubHttpRead short range: wanted " + want + " bytes at "
                    + pos + ", got " + got);
            }
            System.arraycopy(chunk, 0, b, off, want);
            pos += want;
            return want;
        }

        @Override
        public int available() {
            long remaining = length - pos;
            return remaining > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) Math.max(0L, remaining);
        }
    }
}
