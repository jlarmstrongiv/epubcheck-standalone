import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;

import org.teavm.jso.JSBody;

/**
 * TeaVM entry point. Takes the packaged epub through the RANGE-READ feed
 * contract the wasm-era wrapper proved out for multi-GB books
 * (globalThis.__ecSize + __ecRead(target, offset, length) -- see
 * ecshim.HostBook for the contract and the 64 MiB block cache), plus
 * __epubName / __epubArgs, and runs the stock CLI implementation
 * (com.adobe.epubcheck.tool.EpubChecker.run -- the same code Checker.main
 * wraps, minus its System.exit). The book is NEVER materialized on the Java
 * side: the forked classlib entry points (TFile / TFileInputStream /
 * TRandomAccessFile) route the book path to host range reads, which is what
 * lets 16 GB ZIP64 books validate at flat memory.
 *
 * TeaVM-side runtime plumbing installed first:
 *  - "resource:" URL protocol for ClassLoader.getResource[s] (Jing's service
 *    discovery opens those URLs),
 *  - JAXP factory system properties, so javax.xml.* factory lookups resolve by
 *    name to the same implementations the jar resolves via META-INF/services
 *    (Xerces SAX, Saxon transformer) without dynamic classpath scanning.
 *
 * Output contract: the JSON report (--json) is written into the in-memory VFS
 * and handed back through globalThis.__ecJson(json); the CLI exit code lands
 * in globalThis.__ecExit.
 */
public class EpubCheckTeaVM {

    @JSBody(script = "return typeof globalThis.__epubName === 'string' ? globalThis.__epubName : null;")
    private static native String readEpubName();

    // NUL-joined transport (same trick as the GraalVM wrapper): the interop is
    // string-only and U+0000 cannot occur inside a CLI argument.
    @JSBody(script = "return (Array.isArray(globalThis.__epubArgs) && globalThis.__epubArgs.length > 0)"
            + " ? globalThis.__epubArgs.join(String.fromCharCode(0)) : null;")
    private static native String readArgsJoined();

    @JSBody(params = { "json" },
            script = "if (typeof globalThis.__ecJson === 'function') { globalThis.__ecJson(json); }")
    private static native void emitJson(String json);

    @JSBody(params = { "code" }, script = "globalThis.__ecExit = code;")
    private static native void emitExit(int code);

    @JSBody(script = "return globalThis.__ecPlain === true;")
    private static native boolean isPlain();

    @JSBody(script = "return globalThis.__ecRelArg === true;")
    private static native boolean isRelArg();

    @JSBody(script = "return typeof globalThis.__ecTZ === 'string' ? globalThis.__ecTZ : null;")
    private static native String readTzId();

    // Extra files to materialize in the VFS before running (the custom-messages
    // override file -- small side-channel payloads only; expanded-directory
    // CONTENTS stream through the ecshim.HostDir feed instead). Same
    // string-only interop as the epub feed: a count plus indexed path / base64
    // accessors, so no giant joined payload has to be split Java-side.
    @JSBody(script = "return Array.isArray(globalThis.__ecExtraPaths) ? globalThis.__ecExtraPaths.length : 0;")
    private static native int readExtraCount();

    @JSBody(params = { "i" }, script = "return globalThis.__ecExtraPaths[i];")
    private static native String readExtraPath(int i);

    @JSBody(params = { "i" }, script = "return globalThis.__ecExtraB64[i];")
    private static native String readExtraB64(int i);

    // Input path argument used when there is NO range-fed epub (the directory
    // root in expanded-directory mode, the URL in URL-input mode). Null means
    // whatever __epubArgs alone specify.
    @JSBody(script = "return typeof globalThis.__ecInputArg === 'string' ? globalThis.__ecInputArg : null;")
    private static native String readInputArg();

    // Host parent directory (globalThis.__ecHostDir): the REAL directory the
    // input lives in on the host, supplied by the Node driver (the CLI already
    // has the absolute path). When present, the wrapper mounts the input, the
    // HostBook/HostDir feeds, any extra VFS files, AND user.dir under this
    // directory instead of the hardcoded "/work", so epubcheck absolutizes the
    // bare input arg against the REAL host cwd and prints the host path in its
    // no-container single-file error text (FATAL PKG-008 "Unable to read
    // file"). Byte-identical to the native jar run with cwd=<book dir> and
    // arg=<book name>. Null means GRACEFUL DEGRADATION to the "/work" behavior
    // (the library/browser paths carry no host dir).
    @JSBody(script = "return typeof globalThis.__ecHostDir === 'string' ? globalThis.__ecHostDir : null;")
    private static native String readHostDir();

    // globalThis.__ecInputIsDir: the input is a DIRECTORY validated in
    // single-file mode (e.g. `--mode xhtml <dir>`). No byte feed is supplied;
    // the wrapper mounts an EMPTY VFS directory at the input path so
    // epubcheck's File.isDirectory() is true (its toURI adds the trailing
    // slash the jar prints in the location) and its single-file read fails
    // with FileNotFoundException -> IOException -> FATAL(PKG-008), matching the
    // jar byte-for-byte.
    @JSBody(script = "return globalThis.__ecInputIsDir === true;")
    private static native boolean isInputDir();

    // Top-level VFS directory of the PREVIOUS run's host mount (e.g. "/private"
    // for a book under /private/tmp/.../book.epub), or null when the last run
    // mounted under "/work". Deleted at the start of the next main() so a reused
    // engine scope leaves no host-mount tree behind (the sibling of the /work +
    // /tmp wipe below). Runs are serialized, so only one mount exists at a time.
    private static String lastMountRoot;

    public static void main(String[] args) throws Exception {
        // Per-run reset, so ONE engine scope can run main() more than once
        // (the driver reuses a scope across successful validations). Clears
        // every piece of cross-run state this wrapper and the host-feed shims
        // own: the HostBook/HostDir statics and block caches (a stale cache
        // serves the PREVIOUS book's bytes -- proven by a FATAL PKG-008 on a
        // reused scope before this reset existed), the ReportTap probe (each
        // run must re-check whether THIS run's host installed the tap
        // callbacks), and the whole /work + /tmp VFS trees (stale report
        // files would be re-emitted; stale placeholder trees and temp
        // downloads would pollute later listings).
        // On a fresh scope all of this is a no-op. HostHttp keeps no mutable
        // statics (its handles live host-side), and epubcheck's own run state
        // is per-EpubChecker-instance, so nothing else carries over.
        ecshim.HostBook.reset();
        ecshim.HostDir.reset();
        ecshim.ReportTap.reset();
        deleteRecursively(new java.io.File("/work"));
        deleteRecursively(new java.io.File("/tmp"));
        // A host-dir run mounts its tree OUTSIDE /work (under the book's real
        // parent directory); wipe the previous one so a reused scope stays
        // clean. Distinct VFS roots -- /tmp is not aliased to /private/tmp
        // here -- so this never disturbs the temp tree recreated below.
        if (lastMountRoot != null) {
            deleteRecursively(new java.io.File(lastMountRoot));
            lastMountRoot = null;
        }

        ecshim.ResourceUrlSetup.install();
        System.setProperty("javax.xml.parsers.SAXParserFactory",
                "org.apache.xerces.jaxp.SAXParserFactoryImpl");
        System.setProperty("javax.xml.transform.TransformerFactory",
                "net.sf.saxon.TransformerFactoryImpl");
        System.setProperty("org.apache.xerces.xni.parser.XMLParserConfiguration",
                "org.apache.xerces.parsers.XIncludeAwareParserConfiguration");
        // The mount base + working directory. With a host dir supplied
        // (__ecHostDir) the input, its feeds, extra files and user.dir all live
        // under the book's REAL parent directory, so epubcheck's bare-arg
        // absolutization prints the host path (M4 fix). Without one, the base
        // stays "/work" -- byte-for-byte today's behavior (graceful
        // degradation for the library/browser paths, which carry no host dir).
        String hostDir = readHostDir();
        String base = hostDir != null ? hostDir : "/work";
        // TeaVM leaves the standard system properties unset; epubcheck's
        // PathUtil.removeWorkingDirectory NPEs on a null user.dir.
        System.setProperty("user.dir", base);
        System.setProperty("java.io.tmpdir", "/tmp");
        createDirIfMissing("/tmp");
        createDirIfMissing("/work");
        if (!"/work".equals(base)) {
            createDirIfMissing(base);
            // Remember the tree's top-level root so the NEXT run's reset wipes
            // it (see lastMountRoot above).
            lastMountRoot = topLevel(base);
        }
        ecshim.VfsSetup.setUserDir(base);
        ecshim.KeepAlive.keep();

        // __ecTZ: optional IANA zone id -- report timestamps derived from zip
        // entry times format in the default zone like the jar does on a host.
        String tzId = readTzId();
        if (tzId != null) {
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone(tzId));
        }

        String[] userArgs = resolveArgs(args);

        // Materialize any extra VFS files first (the custom-messages override
        // file). Done for every mode, before the run -- under the mount base so
        // a bare `-c <name>` arg resolves against user.dir like the jar's.
        materializeExtraFiles(base);

        // Input path resolution. With a host range feed (__ecSize + __ecRead)
        // the book is served BY THE HOST at <base>/<name> -- nothing is written
        // into the VFS; ecshim.HostBook registers the canonical path and the
        // forked java.io entry points stream it range by range. Without a
        // range feed, the input arg comes from __ecInputArg (the directory
        // root in expanded-directory mode -- where the host directory feed,
        // if installed, streams file contents through ecshim.HostDir -- or
        // the URL in URL-input mode); if that is null too, the stock CLI runs
        // on __epubArgs alone.
        String inputArg;
        String name = resolveName("input.epub");
        java.io.File target = new java.io.File(base, name);
        if (isInputDir()) {
            // Single-file mode pointed at a DIRECTORY: mount an empty VFS
            // directory at the input path (no byte feed). epubcheck sees an
            // existing directory (toURI adds the trailing slash the jar
            // prints) and its single-file read fails -> FATAL(PKG-008).
            createDirIfMissing(target.getPath());
            inputArg = isRelArg() ? name : target.getPath();
        } else if (ecshim.HostBook.activate(target.getCanonicalPath())) {
            // __ecRelArg: pass the bare book name (cwd is the mount base)
            // instead of the absolute VFS path, mirroring the jar ground-truth
            // invocation (cwd=<book dir>, arg=<book name>) so report "path"
            // fields -- and, with a host dir, the absolute path in single-file
            // error text -- match.
            inputArg = isRelArg() ? name : target.getPath();
        } else {
            inputArg = readInputArg();
            if (inputArg != null) {
                activateHostDir(base, inputArg);
            }
        }

        boolean wantsJson = hasJsonFlag(userArgs);
        String jsonPath = "/work/out.json";
        String[] fullArgs;
        if (inputArg == null) {
            // No input path: behave like the stock CLI on whatever __epubArgs say.
            fullArgs = userArgs;
        } else if (wantsJson || isPlain()) {
            // __ecPlain: run the stock CLI exactly as-is (no --json injection),
            // so stdout/stderr match the jar's textual output byte-for-byte.
            fullArgs = append(userArgs, inputArg);
        } else {
            fullArgs = append(userArgs, "--json", jsonPath, inputArg);
        }

        int code = new com.adobe.epubcheck.tool.EpubChecker().run(fullArgs);
        emitExit(code);

        if (!wantsJson) {
            Path out = Paths.get(jsonPath);
            if (Files.exists(out)) {
                emitJson(readUtf8(out));
            }
        }

        // Hand any report files the CLI wrote under /work back to the host
        // (used by the report byte-parity suite for --json/--out/--xmp).
        for (String rf : new String[] { "out.json", "out.xml", "out.xmp" }) {
            Path rp = Paths.get("/work", rf);
            if (Files.exists(rp)) {
                emitFile(rf, readUtf8(rp));
            }
        }
    }

    @JSBody(params = { "name", "content" },
            script = "if (typeof globalThis.__ecFile === 'function') { globalThis.__ecFile(name, content); }")
    private static native void emitFile(String name, String content);

    private static void createDirIfMissing(String dir) {
        java.io.File f = new java.io.File(dir);
        if (!f.exists()) {
            f.mkdirs();
        }
    }

    /**
     * The top-level VFS directory of an absolute path ("/private/tmp/x" ->
     * "/private"), so the per-run reset can wipe the whole host-mount tree
     * created for the previous run. A path with no inner separator (e.g.
     * "/books") is its own top level.
     */
    private static String topLevel(String path) {
        int i = path.indexOf('/', 1);
        return i < 0 ? path : path.substring(0, i);
    }

    /** Delete a VFS tree, children first (part of the per-run reset above). */
    private static void deleteRecursively(java.io.File f) {
        if (!f.exists()) {
            return;
        }
        java.io.File[] children = f.listFiles();
        if (children != null) {
            for (java.io.File child : children) {
                deleteRecursively(child);
            }
        }
        f.delete();
    }

    /**
     * Expanded-directory mode with a host directory feed (__ecDirPaths /
     * __ecDirSizes / __ecDirRead): create the tree's SHAPE in the VFS -- an
     * empty placeholder file per listed path, parents included -- so directory
     * walks, exists/isFile checks and zip-entry creation work through the
     * stock VFS machinery, then activate ecshim.HostDir so the forked java.io
     * entry points serve each placeholder's size and CONTENT from the host
     * on demand. Nothing beyond the shape is materialized: the bytes stream
     * through the feed while epubcheck's expanded-mode zipper reads them.
     * A no-op when the host installed no directory feed.
     *
     * The root directory is mounted even for an EMPTY listing (a feed
     * installed over an empty directory): epubcheck must see an existing
     * empty directory, exactly like the jar pointed at one -- its expanded
     * mode then packages an empty zip and reports PKG-003 + RSC-002 on it.
     * Skipping the mount made the engine claim "Directory not found" for a
     * directory that exists but is empty (parity-audit Gap D).
     */
    private static void activateHostDir(String base, String root) throws IOException {
        if (!ecshim.HostDir.feedInstalled()) {
            return;
        }
        java.io.File rootDir = new java.io.File(base, root);
        if (!rootDir.exists()) {
            rootDir.mkdirs();
        }
        int count = ecshim.HostDir.feedCount();
        if (count <= 0) {
            return;
        }
        for (int i = 0; i < count; i++) {
            String rel = ecshim.HostDir.feedPath(i);
            assertSafeRelative(rel);
            java.io.File fp = new java.io.File(rootDir, rel);
            java.io.File parent = fp.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            // Zero-byte placeholder: the shape only. HostDir serves the size
            // (via the forked TFile.length) and the bytes (via the forked
            // stream classes).
            new FileOutputStream(fp.toString()).close();
        }
        ecshim.HostDir.activate(rootDir.getCanonicalPath());
    }

    /**
     * Reject any listed directory path that could escape the placeholder root:
     * absolute paths, backslashes, and empty/"."/".." segments. The TypeScript
     * plugins enforce the same rules (neither side trusts the other).
     */
    private static void assertSafeRelative(String rel) throws IOException {
        boolean bad = rel == null || rel.isEmpty() || rel.startsWith("/") || rel.indexOf('\\') >= 0;
        if (!bad) {
            for (String segment : rel.split("/", -1)) {
                if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment)) {
                    bad = true;
                    break;
                }
            }
        }
        if (bad) {
            throw new IOException("unsafe expanded-directory path from host feed: " + rel);
        }
    }

    /**
     * Write each extra file (relative to the mount base) into the VFS, creating parent
     * directories as needed. Used for the custom-messages override file.
     */
    private static void materializeExtraFiles(String base) throws IOException {
        int count = readExtraCount();
        for (int i = 0; i < count; i++) {
            String rel = readExtraPath(i);
            byte[] data = Base64.getDecoder().decode(readExtraB64(i));
            // Use java.io.File throughout (like createDirIfMissing): TeaVM's
            // nio Files.createDirectories throws on an already-existing dir,
            // whereas File.mkdirs is idempotent.
            java.io.File fp = new java.io.File(base, rel);
            java.io.File parent = fp.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            try (OutputStream out = new FileOutputStream(fp.toString())) {
                out.write(data);
            }
        }
    }

    private static String[] resolveArgs(String[] mainArgs) {
        String joined = readArgsJoined();
        if (joined == null) {
            return mainArgs != null ? mainArgs : new String[0];
        }
        return joined.split("\u0000", -1);
    }

    private static boolean hasJsonFlag(String[] args) {
        for (String a : args) {
            if ("--json".equals(a) || "-j".equals(a)) {
                return true;
            }
        }
        return false;
    }

    private static String[] append(String[] base, String... extra) {
        String[] out = new String[base.length + extra.length];
        System.arraycopy(base, 0, out, 0, base.length);
        System.arraycopy(extra, 0, out, base.length, extra.length);
        return out;
    }

    private static String readUtf8(Path path) throws IOException {
        try (InputStream in = Files.newInputStream(path)) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            return new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    /** Display name from globalThis.__epubName, reduced to a simple file name. */
    private static String resolveName(String fallback) {
        String name = readEpubName();
        if (name == null) {
            return fallback;
        }
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) {
            name = name.substring(slash + 1);
        }
        if (name.isEmpty() || ".".equals(name) || "..".equals(name)) {
            return fallback;
        }
        return name;
    }
}
