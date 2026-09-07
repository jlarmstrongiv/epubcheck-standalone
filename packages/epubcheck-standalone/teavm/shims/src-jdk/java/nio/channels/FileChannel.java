package java.nio.channels;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.OpenOption;
import java.nio.file.StandardOpenOption;

/**
 * TeaVM shim: working FileChannel over the TeaVM virtual filesystem.
 *
 * WHY THIS IS REAL AND NOT A THROWING STUB: epubcheck's expanded-directory
 * mode (--mode exp) zips the directory into a temp .epub via commons-compress
 * (com.adobe.epubcheck.util.Archive -> ZipArchiveOutputStream(File) ->
 * FileRandomAccessOutputStream -> FileChannel.open). With the former throwing
 * stub, every expanded validation died in Archive.createArchive before any
 * checking ran (and the resulting IOException was even masked into a bare
 * "Check finished with errors" by an exception-handler miscompile logged in
 * agent-docs/teavm-fixes.md).
 *
 * The implementation delegates to java.io.RandomAccessFile, which resolves to
 * the forked TRandomAccessFile over the in-memory VFS, so only its public JDK
 * API is used. Semantics follow the JDK spec for the option sets epubcheck's
 * dependency stack actually uses (CREATE|TRUNCATE_EXISTING|WRITE plus plain
 * READ): open without CREATE on a missing file throws NoSuchFileException, and
 * the positioned write(ByteBuffer, long) does NOT move the channel position
 * (java.nio.channels.FileChannel javadoc).
 *
 * map/lock/tryLock stay unsupported: nothing in the epubcheck stack reaches
 * them (memory-mapping has no VFS equivalent).
 */
public abstract class FileChannel implements SeekableByteChannel {
    protected FileChannel() {
    }

    public static class MapMode {
        public static final MapMode READ_ONLY = new MapMode("READ_ONLY");
        public static final MapMode READ_WRITE = new MapMode("READ_WRITE");
        public static final MapMode PRIVATE = new MapMode("PRIVATE");

        private final String name;

        private MapMode(String name) {
            this.name = name;
        }

        @Override
        public String toString() {
            return name;
        }
    }

    public abstract long position() throws IOException;

    public abstract FileChannel position(long newPosition) throws IOException;

    public abstract long size() throws IOException;

    public abstract int read(ByteBuffer dst) throws IOException;

    public abstract int write(ByteBuffer src) throws IOException;

    public abstract int write(ByteBuffer src, long position) throws IOException;

    public abstract FileChannel truncate(long size) throws IOException;

    public abstract void force(boolean metaData) throws IOException;

    public abstract void close() throws IOException;

    public static FileChannel open(java.nio.file.Path path, OpenOption... options)
            throws IOException {
        boolean read = false;
        boolean write = false;
        boolean create = false;
        boolean createNew = false;
        boolean truncate = false;
        boolean append = false;
        for (OpenOption option : options) {
            if (option instanceof StandardOpenOption) {
                switch ((StandardOpenOption) option) {
                    case READ:
                        read = true;
                        break;
                    case WRITE:
                        write = true;
                        break;
                    case CREATE:
                        create = true;
                        break;
                    case CREATE_NEW:
                        createNew = true;
                        break;
                    case TRUNCATE_EXISTING:
                        truncate = true;
                        break;
                    case APPEND:
                        append = true;
                        break;
                    case SPARSE:
                    case SYNC:
                    case DSYNC:
                        break;
                    case DELETE_ON_CLOSE:
                        throw new UnsupportedOperationException(
                                "FileChannel.open: DELETE_ON_CLOSE is not supported in the TeaVM build");
                }
            } else if (!(option instanceof LinkOption)) {
                throw new UnsupportedOperationException("FileChannel.open: unsupported option " + option);
            }
        }
        // JDK: APPEND may not be combined with READ or TRUNCATE_EXISTING.
        if (append && (read || truncate)) {
            throw new IllegalArgumentException("APPEND + READ or APPEND + TRUNCATE_EXISTING");
        }
        boolean writing = write || append;
        if (!writing) {
            read = true;
        }

        String pathString = path.toString();
        File file = new File(pathString);
        boolean exists = file.exists();
        if (!exists) {
            // JDK: CREATE/CREATE_NEW only take effect when opening for writing.
            if (!writing || (!create && !createNew)) {
                throw new NoSuchFileException(pathString);
            }
            file.createNewFile();
        } else if (createNew && writing) {
            throw new java.nio.file.FileAlreadyExistsException(pathString);
        }

        RandomAccessFile raf = new RandomAccessFile(pathString, writing ? "rw" : "r");
        if (truncate && writing && exists) {
            raf.setLength(0);
        }
        if (append) {
            raf.seek(raf.length());
        }
        return new VfsFileChannel(raf, read, writing);
    }

    public java.nio.MappedByteBuffer map(MapMode mode, long position, long size) throws IOException {
        throw new IOException("FileChannel.map is not supported in the TeaVM build");
    }

    public FileLock lock() throws IOException {
        throw new IOException("FileChannel.lock is not supported in the TeaVM build");
    }

    public FileLock tryLock() throws IOException {
        throw new IOException("FileChannel.tryLock is not supported in the TeaVM build");
    }

    /** The VFS-backed implementation returned by {@link #open}. */
    static final class VfsFileChannel extends FileChannel {
        private final RandomAccessFile file;
        private final boolean readable;
        private final boolean writable;
        private boolean open = true;

        VfsFileChannel(RandomAccessFile file, boolean readable, boolean writable) {
            this.file = file;
            this.readable = readable;
            this.writable = writable;
        }

        private void ensureOpen() throws IOException {
            if (!open) {
                throw new ClosedChannelException();
            }
        }

        @Override
        public boolean isOpen() {
            return open;
        }

        @Override
        public long position() throws IOException {
            ensureOpen();
            return file.getFilePointer();
        }

        @Override
        public FileChannel position(long newPosition) throws IOException {
            ensureOpen();
            if (newPosition < 0) {
                throw new IllegalArgumentException("negative position: " + newPosition);
            }
            file.seek(newPosition);
            return this;
        }

        @Override
        public long size() throws IOException {
            ensureOpen();
            return file.length();
        }

        @Override
        public int read(ByteBuffer dst) throws IOException {
            ensureOpen();
            if (!readable) {
                throw new NonReadableChannelException();
            }
            int wanted = dst.remaining();
            if (wanted == 0) {
                return 0;
            }
            byte[] chunk = new byte[wanted];
            int n = file.read(chunk, 0, wanted);
            if (n <= 0) {
                return -1;
            }
            dst.put(chunk, 0, n);
            return n;
        }

        @Override
        public int write(ByteBuffer src) throws IOException {
            ensureOpen();
            if (!writable) {
                throw new NonWritableChannelException();
            }
            int n = src.remaining();
            if (n == 0) {
                return 0;
            }
            byte[] chunk = new byte[n];
            src.get(chunk);
            file.write(chunk, 0, n);
            return n;
        }

        @Override
        public int write(ByteBuffer src, long position) throws IOException {
            ensureOpen();
            if (!writable) {
                throw new NonWritableChannelException();
            }
            if (position < 0) {
                throw new IllegalArgumentException("negative position: " + position);
            }
            // JDK contract: a positioned write does not modify the channel's
            // own position.
            long saved = file.getFilePointer();
            file.seek(position);
            int n = src.remaining();
            if (n > 0) {
                byte[] chunk = new byte[n];
                src.get(chunk);
                file.write(chunk, 0, n);
            }
            file.seek(saved);
            return n;
        }

        @Override
        public FileChannel truncate(long size) throws IOException {
            ensureOpen();
            if (!writable) {
                throw new NonWritableChannelException();
            }
            if (size < 0) {
                throw new IllegalArgumentException("negative size: " + size);
            }
            // JDK: only shrinks; a size >= current length leaves the file
            // unchanged. Position moves back to the new end if it was beyond.
            if (size < file.length()) {
                file.setLength(size);
            }
            if (file.getFilePointer() > size) {
                file.seek(size);
            }
            return this;
        }

        @Override
        public void force(boolean metaData) throws IOException {
            ensureOpen();
        }

        @Override
        public void close() throws IOException {
            if (open) {
                open = false;
                file.close();
            }
        }
    }
}
