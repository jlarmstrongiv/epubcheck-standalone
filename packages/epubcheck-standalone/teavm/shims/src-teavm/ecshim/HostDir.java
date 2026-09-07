package ecshim;

import java.io.IOException;

import org.teavm.interop.Async;
import org.teavm.interop.AsyncCallback;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSFunctor;
import org.teavm.jso.JSObject;
import org.teavm.jso.typedarrays.Int8Array;

/**
 * The host-backed expanded directory: per-file random-access byte-range reads
 * served by the JS host, so an unpacked-EPUB tree's file CONTENTS are never
 * materialized on the Java side. Only the tree's SHAPE lives in the VFS: the
 * wrapper creates an empty placeholder file per listed path (so directory
 * walks, exists/isFile checks and zip-entry creation work through the stock
 * VFS machinery) and this class serves the bytes when epubcheck's
 * expanded-mode zipper (com.adobe.epubcheck.util.Archive) streams each file.
 *
 * Feed contract (installed by the TypeScript engine driver before main runs;
 * the directory sibling of HostBook's __ecSize/__ecRead single-book feed):
 *   globalThis.__ecDirPaths                     array of relative
 *                                               '/'-separated file paths
 *   globalThis.__ecDirSizes                     array of sizes in bytes,
 *                                               index-aligned with the paths
 *   globalThis.__ecDirRead(target, i, off, n)   fill `target` (an Int8Array
 *                                               view over the requesting Java
 *                                               byte[]) with exactly the bytes
 *                                               [off, off+n) of file i;
 *                                               returns the count written,
 *                                               EITHER synchronously (a
 *                                               number) OR as a thenable
 *                                               resolving to it (an async
 *                                               host read)
 *
 * When the host returns a thenable, the Java green thread SUSPENDS at
 * {@link #feedReadAwait} (TeaVM {@code @Async} native suspend/resume, the
 * exact seam HostBook and HostHttp use) and resumes when the promise settles.
 * A host that fills synchronously (Node fd reads, FileReaderSync in a Worker)
 * never reaches the seam: {@link #feedReadTry} completes the read in one
 * plain synchronous JS call. The thenable passes through the transient
 * globalThis.__ecDirReadPending stash, consumed-and-deleted in the same
 * synchronous stretch (the directory twin of __ecReadPending).
 *
 * Reads go through the same bounded LRU block-cache budget as HostBook
 * (8 MiB blocks, 8 blocks = 64 MiB, keyed by file + block; fixed slots, see
 * the state note below), so a suspension can happen at most once per
 * cache-miss block and peak Java-side memory is independent of the tree's
 * total size. 8 MiB is also the documented maximum
 * single read of the host DirectorySource contract.
 *
 * The wrapper (EpubCheckTeaVM) activates this with the canonical VFS root of
 * the placeholder tree; the forked classlib entry points (TFile,
 * TFileInputStream, TRandomAccessFile) route matching canonical paths here
 * for sizes and content reads and leave every other path on the in-memory
 * VFS. The wrapper calls {@link #reset} at the start of every main(), so all
 * state here is per-run even when the driver reuses one engine scope across
 * validations.
 */
public final class HostDir {
    private HostDir() {
    }

    private static final int BLOCK_SHIFT = 23; // 8 MiB blocks
    private static final int BLOCK_SIZE = 1 << BLOCK_SHIFT;
    private static final int MAX_BLOCKS = 8; // 64 MiB cache

    // All state is PLAIN ARRAYS assigned inside activate() -- deliberately no
    // clinit-created collections and no boxing. activate() runs inside the
    // engine's CPS-lowered (suspendable) startup chain, and a first
    // implementation that did `INDEX.put(...)` on a static final HashMap there
    // died at run start with a raw `TypeError: Cannot read properties of null
    // (reading '<table field>')` inside the CPS-lowered THashMap.put -- the
    // same TeaVM CPS miscompile family agent-docs/teavm-fixes.md documents
    // (state restored wrong across async-lowered frames). Primitive arrays and
    // straight loops compile clean through the CPS lowering.
    private static boolean active;
    /** Canonical VFS path of each listed file, index-aligned with sizes. */
    private static String[] canonicals;
    private static long[] sizes;

    // Fixed-slot LRU block cache (the HostBook budget: 8 x 8 MiB). Linear
    // scan over 8 slots; lastUsed ticks pick the eviction victim.
    private static long[] cacheKeys;
    private static byte[][] cacheBlocks;
    private static long[] cacheUsed;
    private static long cacheTick;

    /**
     * Whether the host installed the directory feed AT ALL -- distinct from
     * {@link #feedCount()} being 0, which is ALSO what an installed feed over
     * an EMPTY directory reports. The wrapper needs the distinction to mount
     * the (empty) directory root for an empty listing, so epubcheck's
     * expanded mode sees an existing empty directory (jar parity: PKG-003 +
     * RSC-002 on the empty package it builds, not "Directory not found").
     */
    @JSBody(script = "return Array.isArray(globalThis.__ecDirPaths)"
            + " && Array.isArray(globalThis.__ecDirSizes)"
            + " && typeof globalThis.__ecDirRead === 'function';")
    public static native boolean feedInstalled();

    @JSBody(script = "return (Array.isArray(globalThis.__ecDirPaths)"
            + " && Array.isArray(globalThis.__ecDirSizes)"
            + " && typeof globalThis.__ecDirRead === 'function')"
            + " ? globalThis.__ecDirPaths.length : 0;")
    public static native int feedCount();

    @JSBody(params = { "i" }, script = "return globalThis.__ecDirPaths[i];")
    public static native String feedPath(int i);

    @JSBody(params = { "i" }, script = "return globalThis.__ecDirSizes[i];")
    private static native double feedSize(int i);

    /**
     * Sentinel {@link #feedReadTry} returns when the host answered with a
     * thenable instead of a count: the read is in flight and must be awaited
     * through {@link #feedReadAwait}. Distinct from every legal count (>= 0)
     * and from the short-read error path (a wrong count throws in block()).
     */
    private static final int READ_PENDING = -2;

    /**
     * Sentinel {@link #feedReadTry} returns when the host's read function
     * THREW synchronously; the message waits in globalThis.__ecDirReadError
     * for {@link #takeReadError} and {@link #block} rethrows it as an
     * IOException carrying the RAW host message (the HostBook.READ_THREW
     * twin -- epubcheck's PKG-008 report text embeds the message verbatim).
     */
    private static final int READ_THREW = -3;

    /**
     * One synchronous call into the host feed. A host that fills the buffer
     * synchronously returns the count and this is the WHOLE read -- the fast
     * path. A host that returns a thenable gets it stashed in
     * globalThis.__ecDirReadPending (picked up -- and deleted -- by
     * feedReadAwaitStart in the SAME synchronous stretch, before the fiber
     * suspends, so nothing else can observe it) and the sentinel comes back
     * instead.
     */
    @JSBody(params = { "target", "index", "offset", "count" },
            script = "var r;"
                + "try { r = globalThis.__ecDirRead(target, index, offset, count); }"
                + "catch (e) {"
                + "globalThis.__ecDirReadError = String((e && e.message) || e);"
                + "return -3;"
                + "}"
                + "if (r !== null && typeof r === 'object' && typeof r.then === 'function') {"
                + "globalThis.__ecDirReadPending = r;"
                + "return -2;"
                + "}"
                + "return r;")
    private static native int feedReadTry(Int8Array target, int index, double offset, int count);

    /** Consume (and clear) the stashed sync-throw message of the last read. */
    @JSBody(script = "var m = globalThis.__ecDirReadError;"
            + "delete globalThis.__ecDirReadError;"
            + "return typeof m === 'string' ? m : 'host directory read failed';")
    private static native String takeReadError();

    /**
     * The JS completion callback wired onto the host's pending read promise:
     * called exactly once when it settles -- with (count, null) on success or
     * (-1, message) on rejection. Promise reactions always run from a later
     * microtask, never re-entrantly, satisfying the same non-reentrancy
     * contract HostBook and HostHttp document for their completion callbacks.
     */
    @JSFunctor
    public interface ReadDone extends JSObject {
        void done(int count, String error);
    }

    @JSBody(params = { "done" },
            script = "var p = globalThis.__ecDirReadPending;"
                + "delete globalThis.__ecDirReadPending;"
                + "p.then(function (n) { done(n | 0, null); },"
                + "function (e) { done(-1, String((e && e.message) || e)); });")
    private static native void feedReadAwaitStart(ReadDone done);

    /**
     * TeaVM native suspend/resume seam (the exact pattern of
     * HostBook.feedReadAwait): the Java green thread SUSPENDS here while the
     * host's async read fills the buffer, and resumes with the count when the
     * promise settles. Only ever called after feedReadTry returned
     * READ_PENDING, so the fully-synchronous host path never suspends.
     */
    @Async
    private static native int feedReadAwait() throws IOException;

    private static void feedReadAwait(AsyncCallback<Integer> callback) {
        feedReadAwaitStart((count, error) -> {
            if (error != null) {
                callback.error(new IOException("host async directory read failed: " + error));
            } else {
                callback.complete(count);
            }
        });
    }

    /**
     * Reset ALL static state to its scope-fresh defaults. Called by the
     * wrapper at the START of every main() so an engine scope can be reused
     * across validations (the sibling of HostBook.reset): a stale listing
     * would misroute file checks and a stale block cache would serve the
     * previous tree's bytes.
     */
    public static void reset() {
        active = false;
        canonicals = null;
        sizes = null;
        cacheKeys = null;
        cacheBlocks = null;
        cacheUsed = null;
        cacheTick = 0;
    }

    /**
     * Activate the host directory feed under the given canonical VFS root
     * (the wrapper has already created the empty placeholder tree there).
     * Registers every listed file's canonical path and size. Returns false
     * (and stays inactive) when the host installed no directory feed.
     */
    public static boolean activate(String canonicalRoot) {
        int count = feedCount();
        if (count <= 0) {
            return false;
        }
        canonicals = new String[count];
        sizes = new long[count];
        for (int i = 0; i < count; i++) {
            canonicals[i] = canonicalRoot + "/" + feedPath(i);
            sizes[i] = (long) feedSize(i);
        }
        cacheKeys = new long[MAX_BLOCKS];
        cacheBlocks = new byte[MAX_BLOCKS][];
        cacheUsed = new long[MAX_BLOCKS];
        cacheTick = 0;
        active = true;
        return true;
    }

    /** Index of the listed file with this canonical path, or -1. Linear scan:
     *  expanded EPUBs hold tens to a few hundred files and lookups happen per
     *  file open / length check, not per byte. */
    private static int indexOf(String canonical) {
        if (!active) {
            return -1;
        }
        for (int i = 0; i < canonicals.length; i++) {
            if (canonicals[i].equals(canonical)) {
                return i;
            }
        }
        return -1;
    }

    /** Is the host directory feed active AND is this canonical path a listed file? */
    public static boolean matches(String canonical) {
        return indexOf(canonical) >= 0;
    }

    /** The listed size of a matching canonical path (0 when not matched). */
    public static long sizeOf(String canonical) {
        int i = indexOf(canonical);
        return i >= 0 ? sizes[i] : 0L;
    }

    /**
     * Read up to len bytes at pos of the listed file `canonical` into
     * buf[off..]. Returns the bytes read (clamped at end of file), or -1 when
     * pos is at/past end of file. Same shape as HostBook.read, plus the
     * per-file dimension.
     */
    public static int read(String canonical, long pos, byte[] buf, int off, int len)
            throws IOException {
        int index = indexOf(canonical);
        if (index < 0) {
            throw new IOException("host directory read of an unlisted path: " + canonical);
        }
        long size = sizes[index];
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
            byte[] block = block(index, blockIndex, size);
            int n = Math.min(len - done, block.length - blockOffset);
            System.arraycopy(block, blockOffset, buf, off + done, n);
            done += n;
        }
        return done;
    }

    private static byte[] block(int index, long blockIndex, long size) throws IOException {
        // Files are int-indexed and a file has at most 2^30 8-MiB blocks
        // (2^53-byte sizes), so (index, block) packs collision-free. Offset
        // by one so slot key 0 always means "empty".
        long key = (((long) index << 31) | blockIndex) + 1;
        int victim = 0;
        for (int i = 0; i < MAX_BLOCKS; i++) {
            if (cacheKeys[i] == key) {
                cacheUsed[i] = ++cacheTick;
                return cacheBlocks[i];
            }
            if (cacheUsed[i] < cacheUsed[victim]) {
                victim = i;
            }
        }
        long start = blockIndex << BLOCK_SHIFT;
        int len = (int) Math.min((long) BLOCK_SIZE, size - start);
        byte[] block = new byte[len];
        int got = feedReadTry(Int8Array.fromJavaArray(block), index, (double) start, len);
        if (got == READ_THREW) {
            // Sync host throw: surface the RAW host message as the
            // IOException epubcheck reports (PKG-008 embeds it verbatim).
            throw new IOException(takeReadError());
        }
        if (got == READ_PENDING) {
            // Async host: suspend this green thread until the promise settles
            // (the host fills `block`'s backing Int8Array before resolving;
            // the byte[] does not move, so the view stays valid across the
            // suspension).
            got = feedReadAwait();
        }
        if (got != len) {
            throw new IOException("host directory range read returned " + got + " of " + len
                    + " bytes at offset " + start + " of " + feedPath(index));
        }
        cacheKeys[victim] = key;
        cacheBlocks[victim] = block;
        cacheUsed[victim] = ++cacheTick;
        return block;
    }
}
