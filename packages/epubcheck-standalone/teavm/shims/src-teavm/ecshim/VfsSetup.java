package ecshim;

import org.teavm.runtime.fs.VirtualFileSystem;
import org.teavm.runtime.fs.VirtualFileSystemProvider;
import org.teavm.runtime.fs.memory.InMemoryVirtualFileSystem;

/**
 * Runtime helper: points the TeaVM in-memory virtual filesystem's working
 * directory at the wrapper's work dir, so relative paths (epubcheck's
 * PathUtil.removeWorkingDirectory output, OCFZipChecker's new File(context.path))
 * resolve exactly like they do for the jar. The java.lang "user.dir" system
 * property is separate plumbing and is set by the wrapper as well.
 */
public final class VfsSetup {
    private VfsSetup() {
    }

    public static void setUserDir(String dir) {
        VirtualFileSystem fs = VirtualFileSystemProvider.getInstance();
        if (fs instanceof InMemoryVirtualFileSystem) {
            ((InMemoryVirtualFileSystem) fs).setUserDir(dir);
        }
    }
}
