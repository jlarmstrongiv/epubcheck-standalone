// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.nio.channels;

import java.io.IOException;

public abstract class FileLock implements AutoCloseable {
    protected FileLock() {
    }

    public abstract boolean isValid();

    public abstract void release() throws IOException;

    @Override
    public final void close() throws IOException {
        release();
    }
}
