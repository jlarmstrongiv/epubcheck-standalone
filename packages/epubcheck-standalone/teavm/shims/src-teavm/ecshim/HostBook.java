package ecshim;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

import org.teavm.interop.Async;
import org.teavm.interop.AsyncCallback;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSFunctor;
import org.teavm.jso.JSObject;
import org.teavm.jso.typedarrays.Int8Array;

/**
 * The host-backed book: random-access byte-range reads served by the JS host,
 * so the packaged epub is NEVER materialized on the Java side (Java arrays cap
 * at ~2 GiB and JS strings at ~512 MB of chars -- a multi-GB book fits in
 * neither).
 *
 * Feed contract (installed by the TypeScript engine driver before main runs):
 *   globalThis.__ecSize                        book size in bytes (number;
 *                                              exact to 2^53)
 *   globalThis.__ecRead(target, offset, len)   fill `target` (an Int8Array
 *                                              view over the requesting Java
 *                                              byte[]) with exactly the bytes
 *                                              [offset, offset+len); returns
 *                                              the count written, EITHER
 *                                              synchronously (a number) OR as
 *                                              a thenable resolving to it (an
 *                                              async host read -- e.g.
 *                                              blob.slice().arrayBuffer() on
 *                                              the browser MAIN thread, where
 *                                              no synchronous file API exists)
 *
 * When the host returns a thenable, the Java green thread SUSPENDS at
 * {@link #feedReadAwait} (TeaVM {@code @Async} native suspend/resume, the
 * exact seam HostHttp uses for URL downloads) and resumes when the promise
 * settles -- the host event loop stays free while the read is in flight.
 * A host that fills synchronously (Node readSync, FileReaderSync in a
 * Worker) never reaches the seam: {@link #feedReadTry} completes the read
 * in one plain synchronous JS call, exactly like before the seam existed.
 * Suspension can only happen once per cache-miss BLOCK (8 MiB), never per
 * engine read, so even the async path suspends rarely.
 *
 * The transport is a typed-array fill, not base64: TeaVM's JS backend backs
 * byte[] with an Int8Array, and Int8Array.fromJavaArray passes that backing
 * store to the host BY REFERENCE (@JSByRef), so the host writes the requested
 * range straight into Java memory with zero copies on the boundary.
 *
 * Reads go through a bounded LRU block cache (8 MiB blocks, 8 blocks = 64 MiB
 * -- the same budget the retired wasm engine's range reader used), so peak
 * Java-side memory is independent of book size. 8 MiB is also the documented
 * maximum single read of the host RangeSource contract.
 *
 * The wrapper (EpubCheckTeaVM) activates this with the book's canonical VFS
 * path; the forked classlib entry points (TFile, TFileInputStream,
 * TRandomAccessFile) route that one path here and leave every other path on
 * the in-memory VFS. The wrapper calls {@link #reset} at the start of every
 * main(), so all state here is per-run even when the driver reuses one engine
 * scope across validations.
 */
public final class HostBook {
    private HostBook() {
    }

    private static final int BLOCK_SHIFT = 23; // 8 MiB blocks
    private static final int BLOCK_SIZE = 1 << BLOCK_SHIFT;
    private static final int MAX_BLOCKS = 8; // 64 MiB cache

    private static boolean active;
    private static String canonicalPath;
    private static long size;
    // When true, blocks are pulled from the http bridge (HostHttp, handle
    // below) instead of the __ecRead range feed -- the URL-input mode, where
    // the "book" is a fetched response body served by the host (spooled to
    // disk in Node, in the consumer worker's memory in the browser).
    private static boolean httpMode;
    private static double httpHandle;

    private static final LinkedHashMap<Long, byte[]> CACHE =
            new LinkedHashMap<Long, byte[]>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<Long, byte[]> eldest) {
                    return size() > MAX_BLOCKS;
                }
            };

    @JSBody(script = "return (typeof globalThis.__ecSize === 'number'"
            + " && typeof globalThis.__ecRead === 'function') ? globalThis.__ecSize : -1;")
    private static native double feedSize();

    /**
     * Sentinel {@link #feedReadTry} returns when the host answered with a
     * thenable instead of a count: the read is in flight and must be awaited
     * through {@link #feedReadAwait}. Distinct from every legal count (>= 0)
     * and from the short-read error path (a wrong count throws in block()).
     */
    private static final int READ_PENDING = -2;

    /**
     * Sentinel {@link #feedReadTry} returns when the host's read function
     * THREW synchronously: the error message is stashed in
     * globalThis.__ecReadError (picked up -- and deleted -- by
     * {@link #takeReadError} in the same synchronous stretch) and
     * {@link #block} rethrows it as an IOException carrying the RAW host
     * message. That raw message is what epubcheck's PKG-008 report text
     * embeds, so a host source that throws a Java-shaped message (e.g.
     * "&lt;path&gt; (Permission denied)" for an unreadable file) makes the
     * engine's output byte-identical to the jar's. Without this conversion a
     * sync JS throw crossed the JSBody as a raw
     * "java.lang.RuntimeException: (JavaScript) ..." that no
     * catch(IOException) in epubcheck could handle.
     */
    private static final int READ_THREW = -3;

    /**
     * One synchronous call into the host feed. A host that fills the buffer
     * synchronously returns the count and this is the WHOLE read -- the fast
     * path, unchanged from before the async seam existed. A host that returns
     * a thenable gets it stashed in globalThis.__ecReadPending (picked up --
     * and deleted -- by feedReadAwaitStart in the SAME synchronous stretch,
     * before the fiber suspends, so nothing else can observe it) and the
     * sentinel comes back instead. A host that THROWS synchronously (an abort
     * sampled at the read seam, an unreadable source) gets its message
     * stashed for {@link #takeReadError} and READ_THREW comes back.
     */
    @JSBody(params = { "target", "offset", "count" },
            script = "var r;"
                + "try { r = globalThis.__ecRead(target, offset, count); }"
                + "catch (e) {"
                + "globalThis.__ecReadError = String((e && e.message) || e);"
                + "return -3;"
                + "}"
                + "if (r !== null && typeof r === 'object' && typeof r.then === 'function') {"
                + "globalThis.__ecReadPending = r;"
                + "return -2;"
                + "}"
                + "return r;")
    private static native int feedReadTry(Int8Array target, double offset, int count);

    /** Consume (and clear) the stashed sync-throw message of the last read. */
    @JSBody(script = "var m = globalThis.__ecReadError;"
            + "delete globalThis.__ecReadError;"
            + "return typeof m === 'string' ? m : 'host range read failed';")
    private static native String takeReadError();

    /**
     * The JS completion callback wired onto the host's pending read promise:
     * called exactly once when it settles -- with (count, null) on success or
     * (-1, message) on rejection. Promise reactions always run from a later
     * microtask, never re-entrantly, satisfying the same non-reentrancy
     * contract HostHttp documents for its completion callback.
     */
    @JSFunctor
    public interface ReadDone extends JSObject {
        void done(int count, String error);
    }

    @JSBody(params = { "done" },
            script = "var p = globalThis.__ecReadPending;"
                + "delete globalThis.__ecReadPending;"
                + "p.then(function (n) { done(n | 0, null); },"
                + "function (e) { done(-1, String((e && e.message) || e)); });")
    private static native void feedReadAwaitStart(ReadDone done);

    /**
     * TeaVM native suspend/resume seam (the exact pattern of
     * HostHttp.httpGet): the Java green thread SUSPENDS here while the host's
     * async read fills the buffer, and resumes with the count when the
     * promise settles. Only ever called after feedReadTry returned
     * READ_PENDING, so the fully-synchronous host path never suspends.
     */
    @Async
    private static native int feedReadAwait() throws IOException;

    private static void feedReadAwait(AsyncCallback<Integer> callback) {
        feedReadAwaitStart((count, error) -> {
            if (error != null) {
                callback.error(new IOException("host async range read failed: " + error));
            } else {
                callback.complete(count);
            }
        });
    }

    /**
     * Reset ALL static state to its scope-fresh defaults. Called by the
     * wrapper at the START of every main() so an engine scope can be reused
     * across validations: without this, the block cache would serve the
     * PREVIOUS book's bytes to the next run (proven: a reused scope failed
     * with FATAL PKG-008 on a garbage central directory until the cache was
     * cleared) and a stale active/canonicalPath would misroute file checks.
     */
    public static void reset() {
        active = false;
        canonicalPath = null;
        size = 0;
        httpMode = false;
        httpHandle = 0;
        CACHE.clear();
    }

    /**
     * Activate the host feed under the given canonical VFS path. Returns false
     * (and stays inactive) when the host installed no range feed -- the
     * wrapper then falls back to its other input modes.
     */
    public static boolean activate(String path) {
        double s = feedSize();
        if (s < 0) {
            return false;
        }
        canonicalPath = path;
        size = (long) s;
        active = true;
        CACHE.clear();
        return true;
    }

    /**
     * Activate the host-backed book under the given canonical VFS path with
     * the HTTP bridge as the byte source: range reads route to
     * HostHttp.fill(handle, ...) instead of the __ecRead feed. Used by the
     * shadowed EpubCheck(InputStream, ...) constructor for URL inputs, keyed
     * to the temp-file path the stock code names the download after -- the
     * temp file itself stays empty; every read is served by the host, so the
     * whole body never lands in the in-memory VFS (no size cap). Same fresh
     * per-run static state as the regular feed.
     */
    public static void activateHttp(String path, double handle, long bookSize) {
        canonicalPath = path;
        size = bookSize;
        httpHandle = handle;
        httpMode = true;
        active = true;
        CACHE.clear();
    }

    /** Is the host feed active AND is this canonical path the book? */
    public static boolean matches(String canonical) {
        return active && canonicalPath.equals(canonical);
    }

    public static long size() {
        return size;
    }

    /**
     * Read up to len bytes at pos into buf[off..]. Returns the bytes read
     * (clamped at end of file), or -1 when pos is at/past end of file.
     */
    public static int read(long pos, byte[] buf, int off, int len) throws IOException {
        if (len == 0) {
            return 0;
        }
        if (pos >= size) {
            return -1;
        }
        long remaining = size - pos;
        if (len > remaining) {
            len = (int) remaining;
        }
        int done = 0;
        while (done < len) {
            long p = pos + done;
            long blockIndex = p >> BLOCK_SHIFT;
            int blockOffset = (int) (p & (BLOCK_SIZE - 1));
            byte[] block = block(blockIndex);
            int n = Math.min(len - done, block.length - blockOffset);
            System.arraycopy(block, blockOffset, buf, off + done, n);
            done += n;
        }
        return done;
    }

    private static byte[] block(long index) throws IOException {
        Long key = index;
        byte[] cached = CACHE.get(key);
        if (cached != null) {
            return cached;
        }
        long start = index << BLOCK_SHIFT;
        int len = (int) Math.min((long) BLOCK_SIZE, size - start);
        byte[] block = new byte[len];
        int got;
        if (httpMode) {
            // The http bridge feed: HostHttp.fill carries the SAME
            // sync-fast-path / thenable-suspends contract as feedReadTry +
            // feedReadAwait below (it probes __epubHttpRead, converts a sync
            // host throw to an IOException, and suspends this green thread
            // when the host returns a promise) -- so both branches of block()
            // suspend at most once per 8 MiB block.
            got = HostHttp.fill(httpHandle, start, block);
        } else {
            got = feedReadTry(Int8Array.fromJavaArray(block), (double) start, len);
            if (got == READ_THREW) {
                // Sync host throw: surface the RAW host message as the
                // IOException epubcheck reports (PKG-008 embeds it verbatim).
                throw new IOException(takeReadError());
            }
            if (got == READ_PENDING) {
                // Async host: suspend this green thread until the promise
                // settles (the host fills `block`'s backing Int8Array before
                // resolving; the byte[] does not move, so the view stays
                // valid across the suspension).
                got = feedReadAwait();
            }
        }
        if (got != len) {
            throw new IOException("host range read returned " + got + " of " + len
                    + " bytes at offset " + start);
        }
        CACHE.put(key, block);
        return block;
    }
}
