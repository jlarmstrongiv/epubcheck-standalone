/*
 *  Copyright 2017 Alexey Andreev.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
package org.teavm.classlib.java.io;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.Objects;
import org.teavm.runtime.fs.VirtualFile;
import org.teavm.runtime.fs.VirtualFileAccessor;

public class TFileInputStream extends InputStream {
    private static final byte[] ONE_BYTE_BUFFER = new byte[1];
    private VirtualFileAccessor accessor;

    // --- epubcheck-standalone TeaVM shim addition: host-backed interception -------
    // When the opened path IS the host-backed book (ecshim.HostBook) or a
    // host-backed expanded-directory file (ecshim.HostDir), stream it via
    // long-offset host range reads instead of a VFS accessor (whose whole API
    // is int-sized). `hostOpen` doubles as the open/closed flag for this mode;
    // `accessor` stays null. `hostDirPath` selects the HostDir per-file feed
    // (null means the single-book HostBook feed).
    private boolean hostOpen;
    private long hostPos;
    private String hostDirPath;

    private int hostRead(byte[] b, int off, int len) throws IOException {
        return hostDirPath != null
                ? ecshim.HostDir.read(hostDirPath, hostPos, b, off, len)
                : ecshim.HostBook.read(hostPos, b, off, len);
    }

    private long hostSize() {
        return hostDirPath != null ? ecshim.HostDir.sizeOf(hostDirPath) : ecshim.HostBook.size();
    }

    public TFileInputStream(TFile file) throws FileNotFoundException {
        if (file.shimIsHostBook()) {
            hostOpen = true;
            return;
        }
        if (file.shimIsHostDirFile()) {
            hostDirPath = file.shimCanonicalPath();
            hostOpen = true;
            return;
        }
        VirtualFile virtualFile = file.findVirtualFile();
        if (virtualFile == null || !virtualFile.isFile()) {
            throw new FileNotFoundException();
        }

        accessor = virtualFile.createAccessor(true, false, false);
        if (accessor == null) {
            throw new FileNotFoundException();
        }
    }

    public TFileInputStream(String path) throws FileNotFoundException {
        this(new TFile(path));
    }

    public TFileInputStream(VirtualFileAccessor accessor) {
        this.accessor = accessor;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
        Objects.requireNonNull(b);
        if (off < 0 || len < 0 || off > b.length - len) {
            throw new IndexOutOfBoundsException();
        }
        if (len == 0) {
            return 0;
        }
        ensureOpened();
        if (hostOpen) {
            int result = hostRead(b, off, len);
            if (result > 0) {
                hostPos += result;
            }
            return result;
        }
        int result = accessor.read(b, off, len);
        return result > 0 ? result : -1;
    }

    @Override
    public long skip(long n) throws IOException {
        if (n < 0) {
            throw new IOException("Value must be positive: " + n);
        }
        ensureOpened();
        if (hostOpen) {
            long skipped = Math.min(n, Math.max(0L, hostSize() - hostPos));
            hostPos += skipped;
            return skipped;
        }
        int last = accessor.tell();
        accessor.skip((int) n - 1);
        if (accessor.read(ONE_BYTE_BUFFER, 0, 1) < 1) {
            int position = accessor.size();
            accessor.seek(position);
            return position - last;
        }
        return n;
    }

    @Override
    public int available() throws IOException {
        ensureOpened();
        if (hostOpen) {
            long remaining = hostSize() - hostPos;
            return remaining <= 0 ? 0 : (int) Math.min(remaining, (long) Integer.MAX_VALUE);
        }
        return Math.max(0, accessor.size() - accessor.tell());
    }

    @Override
    public void close() throws IOException {
        if (accessor != null) {
            accessor.close();
        }
        accessor = null;
        hostOpen = false;
        hostDirPath = null;
    }

    @Override
    public int read() throws IOException {
        ensureOpened();
        byte[] buffer = ONE_BYTE_BUFFER;
        if (hostOpen) {
            int read = hostRead(buffer, 0, 1);
            if (read > 0) {
                hostPos += read;
                return buffer[0] & 0xff;
            }
            return -1;
        }
        int read = accessor.read(buffer, 0, 1);
        return read != 0 ? buffer[0] : -1;
    }

    private void ensureOpened() throws IOException {
        if (accessor == null && !hostOpen) {
            throw new IOException("This stream is already closed");
        }
    }

    // --- epubcheck-standalone TeaVM shim additions (fork of the stock classlib file) ---

    public java.nio.channels.FileChannel getChannel() {
        throw new UnsupportedOperationException("FileChannel is not supported in the TeaVM build");
    }

}
