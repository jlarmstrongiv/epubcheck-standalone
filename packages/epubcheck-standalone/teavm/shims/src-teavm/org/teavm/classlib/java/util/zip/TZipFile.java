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

package org.teavm.classlib.java.util.zip;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.Enumeration;
import java.util.Iterator;
import java.util.LinkedHashMap;
import org.teavm.classlib.java.io.TCloseable;
import org.teavm.classlib.java.util.zip.TZipEntry.LittleEndianReader;

public class TZipFile implements TZipConstants, TCloseable {
    public static final int OPEN_READ = 1;
    public static final int OPEN_DELETE = 4;

    private final String fileName;
    private File fileToDeleteOnClose;
    private RandomAccessFile mRaf;
    private final LittleEndianReader ler = new LittleEndianReader();

    private final LinkedHashMap<String, TZipEntry> mEntries = new LinkedHashMap<>();
    // --- epubcheck-standalone TeaVM shim addition: the JDK enumerates ALL central
    // directory entries including duplicate names (epubcheck's OPF-060
    // duplicate-entry check depends on seeing them); a name-keyed map alone
    // silently collapses duplicates.
    private final java.util.ArrayList<TZipEntry> mEntryList = new java.util.ArrayList<>();

    public TZipFile(File file) throws TZipException, IOException {
        this(file, OPEN_READ);
    }

    // --- epubcheck-standalone TeaVM shim additions (fork of the stock classlib file) ---

    public TZipFile(File file, java.nio.charset.Charset charset) throws TZipException, IOException {
        this(file);
    }

    public TZipFile(File file, int mode) throws IOException {
        fileName = file.getPath();
        if (mode != OPEN_READ && mode != (OPEN_READ | OPEN_DELETE)) {
            throw new IllegalArgumentException();
        }

        if ((mode & OPEN_DELETE) != 0) {
            fileToDeleteOnClose = file; // file.deleteOnExit();
        } else {
            fileToDeleteOnClose = null;
        }

        mRaf = new RandomAccessFile(fileName, "r");

        readCentralDir();
    }

    public TZipFile(String name) throws IOException {
        this(new File(name), OPEN_READ);
    }

    @Override
    public void close() throws IOException {
        RandomAccessFile raf = mRaf;

        if (raf != null) {
            mRaf = null;
            raf.close();
            if (fileToDeleteOnClose != null) {
                new File(fileName).delete();
                // fileToDeleteOnClose.delete();
                fileToDeleteOnClose = null;
            }
        }
    }

    private void checkNotClosed() {
        if (mRaf == null) {
            throw new IllegalStateException();
        }
    }

    public Enumeration<? extends TZipEntry> entries() {
        checkNotClosed();
        final Iterator<TZipEntry> iterator = mEntryList.iterator();

        return new Enumeration<TZipEntry>() {
            @Override
            public boolean hasMoreElements() {
                checkNotClosed();
                return iterator.hasNext();
            }

            @Override
            public TZipEntry nextElement() {
                checkNotClosed();
                return iterator.next();
            }
        };
    }

    public TZipEntry getEntry(String entryName) {
        checkNotClosed();
        if (entryName == null) {
            throw new NullPointerException();
        }

        TZipEntry ze = mEntries.get(entryName);
        if (ze == null) {
            ze = mEntries.get(entryName + "/");
        }
        return ze;
    }

    public InputStream getInputStream(TZipEntry entry) throws IOException {
        /*
         * Make sure this TZipEntry is in this Zip file.  We run it through
         * the name lookup.
         */
        entry = getEntry(entry.getName());
        if (entry == null) {
            return null;
        }

        /*
         * Create a TZipInputStream at the right part of the file.
         */
        RandomAccessFile raf = mRaf;
        // We don't know the entry data's start position. All we have is the
        // position of the entry's local header. At position 28 we find the
        // length of the extra data. In some cases this length differs from
        // the one coming in the central header.
        RAFStream rafstrm = new RAFStream(raf, entry.mLocalHeaderRelOffset + 28);
        int localExtraLenOrWhatever = ler.readShortLE(rafstrm);
        // Skip the name and this "extra" data or whatever it is:
        rafstrm.skip(entry.nameLen + localExtraLenOrWhatever);
        rafstrm.mLength = rafstrm.mOffset + entry.compressedSize;
        if (entry.compressionMethod == java.util.zip.ZipEntry.DEFLATED) {
            int bufSize = Math.max(1024, (int) Math.min(entry.getSize(), 65535L));
            return new ZipInflaterInputStream(rafstrm, new TInflater(true), bufSize, entry);
        } else {
            return rafstrm;
        }
    }

    public String getName() {
        return fileName;
    }

    public int size() {
        checkNotClosed();
        return mEntryList.size();
    }

    /**
     * Find the central directory and read the contents.
     *
     * <p>The central directory can be followed by a variable-length comment
     * field, so we have to scan through it backwards.  The comment is at
     * most 64K, plus we have 18 bytes for the end-of-central-dir stuff
     * itself, plus apparently sometimes people throw random junk on the end
     * just for the fun of it.
     *
     * <p>This is all a little wobbly.  If the wrong value ends up in the EOCD
     * area, we're hosed. This appears to be the way that everybody handles
     * it though, so we're in good company if this fails.
     */
    private void readCentralDir() throws IOException {
        /*
         * Scan back, looking for the End Of Central Directory field.  If
         * the archive doesn't have a comment, we'll hit it on the first
         * try.
         *
         * No need to synchronize mRaf here -- we only do this when we
         * first open the Zip file.
         */
        // epubcheck-standalone shim: JDK-matching exception messages (epubcheck's
        // PKG-008 report text includes them; the baselines expect the JDK
        // wording).
        long scanOffset = mRaf.length() - ENDHDR;
        if (scanOffset < 0) {
            if (mRaf.length() == 0) {
                throw new TZipException("zip file is empty");
            }
            throw new TZipException("zip END header not found");
        }

        long stopOffset = scanOffset - 65536;
        if (stopOffset < 0) {
            stopOffset = 0;
        }

        while (true) {
            mRaf.seek(scanOffset);
            if (TZipEntry.readIntLE(mRaf) == 101010256L) {
                // epubcheck-standalone shim: the JDK validates an EOCD candidate by
                // requiring the comment length to align with the end of the
                // file; without this, a spurious PK\5\6 inside arbitrary data
                // (e.g. an image renamed to .epub) is accepted and the bogus
                // central-directory offset dies later with a message-less
                // EOFException instead of the JDK's "zip END header not found".
                mRaf.seek(scanOffset + 20);
                int c0 = mRaf.read();
                int c1 = mRaf.read();
                if (c0 >= 0 && c1 >= 0) {
                    long commentLen = (c0 & 0xff) | ((c1 & 0xff) << 8);
                    if (scanOffset + ENDHDR + commentLen == mRaf.length()) {
                        mRaf.seek(scanOffset + 4);
                        break;
                    }
                }
            }

            scanOffset--;
            if (scanOffset < stopOffset) {
                throw new TZipException("zip END header not found");
            }
        }

        /*
         * Found it, read the EOCD.
         *
         * For performance we want to use buffered I/O when reading the
         * file.  We wrap a buffered stream around the random-access file
         * object.  If we just read from the RandomAccessFile we'll be
         * doing a read() system call every time.
         */
        RAFStream rafs = new RAFStream(mRaf, mRaf.getFilePointer());
        BufferedInputStream bin = new BufferedInputStream(rafs, ENDHDR);

        int diskNumber = ler.readShortLE(bin);
        int diskWithCentralDir = ler.readShortLE(bin);
        int numEntries = ler.readShortLE(bin);
        int totalNumEntries = ler.readShortLE(bin);
        long centralDirSize = ler.readIntLE(bin);
        long centralDirOffset = ler.readIntLE(bin);
        /*commentLen =*/ ler.readShortLE(bin);

        if (numEntries != totalNumEntries || diskNumber != 0 || diskWithCentralDir != 0) {
            throw new TZipException();
        }

        long totalEntries = totalNumEntries;

        // --- epubcheck-standalone TeaVM shim addition: ZIP64 support (fork of the
        // stock classlib file). Stock code read only the classic EOCD, whose
        // fields cap at 65535 entries / 4 GiB offsets -- every field past the
        // cap holds a sentinel (0xffff / 0xffffffff) and the real values live
        // in the ZIP64 end-of-central-directory record, found via a 20-byte
        // locator placed immediately before the classic EOCD. Mirror the JDK:
        // probe the locator only when a classic field holds its sentinel, and
        // take a ZIP64 value only for the fields that were sentinels.
        long eocdOffset = scanOffset;
        if (numEntries == 0xffff || totalNumEntries == 0xffff
                || centralDirOffset == 0xffffffffL || centralDirSize == 0xffffffffL) {
            long locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE;
            if (locatorOffset >= 0) {
                mRaf.seek(locatorOffset);
                if (readUnsignedIntLE(mRaf) == ZIP64_LOCSIG) {
                    long diskWithZip64Eocd = readUnsignedIntLE(mRaf);
                    long zip64EocdOffset = readLongLE(mRaf);
                    long totalDisks = readUnsignedIntLE(mRaf);
                    if (diskWithZip64Eocd == 0 && totalDisks <= 1
                            && zip64EocdOffset >= 0 && zip64EocdOffset < locatorOffset) {
                        mRaf.seek(zip64EocdOffset);
                        if (readUnsignedIntLE(mRaf) == ZIP64_ENDSIG) {
                            readLongLE(mRaf); // size of this record (excl. sig + this field)
                            readUnsignedShortLE(mRaf); // version made by
                            readUnsignedShortLE(mRaf); // version needed
                            long z64DiskNumber = readUnsignedIntLE(mRaf);
                            long z64DiskWithCd = readUnsignedIntLE(mRaf);
                            long z64EntriesOnDisk = readLongLE(mRaf);
                            long z64TotalEntries = readLongLE(mRaf);
                            readLongLE(mRaf); // central directory size
                            long z64CdOffset = readLongLE(mRaf);
                            if (z64DiskNumber != 0 || z64DiskWithCd != 0
                                    || z64EntriesOnDisk != z64TotalEntries) {
                                throw new TZipException();
                            }
                            if (totalNumEntries == 0xffff) {
                                totalEntries = z64TotalEntries;
                            }
                            if (centralDirOffset == 0xffffffffL) {
                                centralDirOffset = z64CdOffset;
                            }
                        }
                    }
                }
            }
        }

        // epubcheck-standalone shim: an EMPTY archive (zero entries -- e.g. a
        // bare end-of-central-directory record, or the zip epubcheck's own
        // expanded mode packages from an empty directory) has no central
        // directory entry to scan for. The JDK opens such a file fine and
        // enumerates zero entries; the CENSIG scan below would instead walk
        // into the EOCD and throw a message-less ZipException, which
        // epubcheck surfaced as FATAL PKG-008 'Unable to read file "null"'
        // where the jar reports RSC-002 (parity-audit Gap D).
        if (totalEntries == 0) {
            return;
        }

        /*
         * Seek to the first CDE and read all entries.
         * However, when Z_SYNC_FLUSH is used the offset may not point directly
         * to the CDE so skip over until we find it.
         * At most it will be 6 bytes away (one or two bytes for empty block, 4 bytes for
         * empty block signature).
         */
        scanOffset = centralDirOffset;
        stopOffset = scanOffset + 6;

        while (true) {
            mRaf.seek(scanOffset);
            if (TZipEntry.readIntLE(mRaf) == CENSIG) {
                break;
            }

            scanOffset++;
            if (scanOffset > stopOffset) {
                throw new TZipException();
            }
        }

        // If CDE is found then go and read all the entries
        rafs = new RAFStream(mRaf, scanOffset);
        bin = new BufferedInputStream(rafs, 4096);
        for (long i = 0; i < totalEntries; i++) {
            TZipEntry newEntry = new TZipEntry(ler, bin);
            // epubcheck-standalone shim: keep every entry (duplicates included) for
            // enumeration; first entry wins for name lookup (JDK behavior).
            mEntryList.add(newEntry);
            if (!mEntries.containsKey(newEntry.getName())) {
                mEntries.put(newEntry.getName(), newEntry);
            }
        }
    }

    // --- epubcheck-standalone TeaVM shim additions: ZIP64 record constants/readers ---

    /** "PK\6\6" -- ZIP64 end-of-central-directory record signature. */
    private static final long ZIP64_ENDSIG = 0x06064b50L;
    /** "PK\6\7" -- ZIP64 end-of-central-directory locator signature. */
    private static final long ZIP64_LOCSIG = 0x07064b50L;
    /** The ZIP64 EOCD locator is a fixed 20 bytes, directly before the EOCD. */
    private static final int ZIP64_LOCATOR_SIZE = 20;

    private static int readUnsignedShortLE(RandomAccessFile raf) throws IOException {
        byte[] b = readFullyRaf(raf, 2);
        return (b[0] & 0xff) | ((b[1] & 0xff) << 8);
    }

    private static long readUnsignedIntLE(RandomAccessFile raf) throws IOException {
        byte[] b = readFullyRaf(raf, 4);
        return ((b[0] & 0xffL)) | ((b[1] & 0xffL) << 8) | ((b[2] & 0xffL) << 16)
                | ((b[3] & 0xffL) << 24);
    }

    private static long readLongLE(RandomAccessFile raf) throws IOException {
        byte[] b = readFullyRaf(raf, 8);
        long v = 0;
        for (int i = 7; i >= 0; i--) {
            v = (v << 8) | (b[i] & 0xffL);
        }
        return v;
    }

    private static byte[] readFullyRaf(RandomAccessFile raf, int count) throws IOException {
        byte[] b = new byte[count];
        int done = 0;
        while (done < count) {
            int n = raf.read(b, done, count - done);
            if (n <= 0) {
                throw new java.io.EOFException();
            }
            done += n;
        }
        return b;
    }

    static class RAFStream extends InputStream {

        RandomAccessFile mSharedRaf;
        long mOffset;
        long mLength;

        public RAFStream(RandomAccessFile raf, long pos) throws IOException {
            mSharedRaf = raf;
            mOffset = pos;
            mLength = raf.length();
        }

        @Override
        public int available() throws IOException {
            if (mLength > mOffset) {
                if (mLength - mOffset < Integer.MAX_VALUE) {
                    return (int) (mLength - mOffset);
                } else {
                    return Integer.MAX_VALUE;
                }
            } else {
                return 0;
            }
        }

        @Override
        public int read() throws IOException {
            byte[] singleByteBuf = new byte[1];
            if (read(singleByteBuf, 0, 1) == 1) {
                return singleByteBuf[0] & 0XFF;
            } else {
                return -1;
            }
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            mSharedRaf.seek(mOffset);
            if (len > mLength - mOffset) {
                len = (int) (mLength - mOffset);
            }
            int count = mSharedRaf.read(b, off, len);
            if (count > 0) {
                mOffset += count;
                return count;
            } else {
                return -1;
            }
        }

        @Override
        public long skip(long n) throws IOException {
            if (n > mLength - mOffset) {
                n = mLength - mOffset;
            }
            mOffset += n;
            return n;
        }
    }
    
    static class ZipInflaterInputStream extends TInflaterInputStream {
        TZipEntry entry;
        long bytesRead;
        private boolean fedDummyByte;

        public ZipInflaterInputStream(InputStream is, TInflater inf, int bsize, TZipEntry entry) {
            super(is, inf, bsize);
            this.entry = entry;
        }

        // --- epubcheck-standalone TeaVM shim fix (fork of the stock classlib file) ---
        // The JDK's ZipFile inflater stream feeds ONE dummy zero byte after the
        // underlying (length-limited) stream ends: a raw DEFLATE decoder can
        // need one more byte to conclude the final block. Without it, entries
        // whose compressed data ends on that boundary die with a message-less
        // EOFException mid-read (surfaced as PKG-008 'Unable to read file
        // "null"' during epubcheck's OCF walk).
        @Override
        protected void fill() throws IOException {
            if (closed) {
                throw new IOException("Stream is closed");
            }
            int n = in.read(buf);
            if (n == -1) {
                if (fedDummyByte) {
                    len = -1;
                    return;
                }
                fedDummyByte = true;
                buf[0] = 0;
                len = 1;
            } else {
                len = n;
            }
            if (len > 0) {
                inf.setInput(buf, 0, len);
            }
        }

        @Override
        public int read(byte[] buffer, int off, int nbytes) throws IOException {
            int i = super.read(buffer, off, nbytes);
            if (i != -1) {
                bytesRead += i;
            }
            return i;
        }

        // --- epubcheck-standalone TeaVM shim fix ---
        // Stock TInflaterInputStream.skip() reads decompressed bytes into
        // `this.buf` -- the SAME array fill() hands to the inflater as its
        // input (setInput(buf, ...)). When a skip spans an input refill the
        // inflater's pending input is overwritten by its own output and the
        // stream decodes garbage (epubcheck then flags valid JPEGs as
        // corrupt). The JDK uses a local scratch buffer; do the same.
        @Override
        public long skip(long nbytes) throws IOException {
            if (nbytes < 0) {
                throw new IllegalArgumentException();
            }
            byte[] scratch = new byte[512];
            long count = 0;
            while (count < nbytes) {
                long rem = nbytes - count;
                int x = read(scratch, 0, rem > scratch.length ? scratch.length : (int) rem);
                if (x == -1) {
                    return count;
                }
                count += x;
            }
            return count;
        }

        @Override
        public int available() throws IOException {
            return super.available() == 0 ? 0 : (int) (entry.getSize() - bytesRead);
        }
    }
}
