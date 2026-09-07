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

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.io.UnsupportedEncodingException;
import java.util.Calendar;
import java.util.Date;
import java.util.GregorianCalendar;

public class TZipEntry implements TZipConstants, Cloneable {
    String name;
    String comment;
    long compressedSize = -1;
    long crc = -1;
    long size = -1;
    int compressionMethod = -1;
    int time = -1;
    int modDate = -1;
    byte[] extra;
    int nameLen = -1;
    long mLocalHeaderRelOffset = -1;

    public static final int DEFLATED = 8;
    public static final int STORED = 0;

    public TZipEntry(String name) {
        if (name == null) {
            throw new NullPointerException();
        }
        if (name.length() > 0xFFFF) {
            throw new IllegalArgumentException();
        }
        this.name = name;
    }

    public String getComment() {
        return comment;
    }

    public long getCompressedSize() {
        return compressedSize;
    }

    public long getCrc() {
        return crc;
    }

    public byte[] getExtra() {
        return extra;
    }

    public int getMethod() {
        return compressionMethod;
    }

    public String getName() {
        return name;
    }

    public long getSize() {
        return size;
    }

    public long getTime() {
        return getTimeInternal();
    }

    // --- epubcheck-standalone shim fix: NON-VIRTUAL body of getTime(), also
    // used by getLastModifiedTime(). Subclasses (commons-compress
    // ZipArchiveEntry, reached by epubcheck's --mode exp zip writer) override
    // BOTH getTime() and getLastModifiedTime() in terms of each other and rely
    // on the JDK base class reading its own fields directly; routing the
    // base-class getLastModifiedTime() through the virtual getTime() recursed
    // forever (see setLastModifiedTime below for the write-side twin).
    private long getTimeInternal() {
        // JDK semantics: a FileTime set via setLastModifiedTime is
        // authoritative and precise (java.util.zip.ZipEntry.getTime returns
        // mtime when present).
        if (shimMtimeMillis != Long.MIN_VALUE) {
            return shimMtimeMillis;
        }
        // --- epubcheck-standalone TeaVM shim fix (fork of the stock classlib file) ---
        // Stock code converted the DOS timestamp through GregorianCalendar,
        // whose TeaVM implementation mixes the JS host's local offset into the
        // conversion while the default TimeZone reports GMT -- the formatted
        // wall-clock digits came out shifted vs the DOS fields. The JDK
        // interprets DOS time in the default zone and formats in the default
        // zone, so the DIGITS always round-trip to the DOS fields verbatim.
        // Reproduce that invariant zone-independently: interpret the DOS
        // fields as UTC with plain epoch arithmetic (TeaVM's default zone is
        // GMT, so formatting reproduces the same digits the jar prints).
        // Like the JDK, prefer the precise UTC timestamp from the
        // extended-timestamp (0x5455) or NTFS (0x000a) extra field when the
        // archive carries one; DOS fields are the fallback.
        long xt = extraFieldMtime();
        if (xt != Long.MIN_VALUE) {
            return xt;
        }
        if (time != -1) {
            int year = 1980 + ((modDate >> 9) & 0x7f);
            int month = (modDate >> 5) & 0xf;
            int day = modDate & 0x1f;
            int hh = (time >> 11) & 0x1f;
            int mm = (time >> 5) & 0x3f;
            int ss = (time & 0x1f) << 1;
            long days = daysFromCivil(year, month, day);
            long asUtc = days * 86400000L + hh * 3600000L + mm * 60000L + ss * 1000L;
            // JDK semantics: DOS fields are wall-clock time in the DEFAULT
            // zone (so formatting in the default zone reproduces the DOS
            // digits verbatim, like the jar). Two-pass offset resolution
            // handles DST boundaries the same way Calendar does in practice.
            java.util.TimeZone tz = java.util.TimeZone.getDefault();
            long guess = asUtc - tz.getOffset(asUtc);
            guess = asUtc - tz.getOffset(guess);
            return guess;
        }
        return -1;
    }

    /** Modification time from the extra field, or Long.MIN_VALUE if absent. */
    private long extraFieldMtime() {
        byte[] x = extra;
        if (x == null) {
            return Long.MIN_VALUE;
        }
        int off = 0;
        while (off + 4 <= x.length) {
            int tag = (x[off] & 0xff) | ((x[off + 1] & 0xff) << 8);
            int sz = (x[off + 2] & 0xff) | ((x[off + 3] & 0xff) << 8);
            int p = off + 4;
            if (p + sz > x.length) {
                break;
            }
            if (tag == 0x5455 && sz >= 5) { // Info-ZIP extended timestamp
                int flags = x[p] & 0xff;
                if ((flags & 1) != 0) {
                    long secs = (x[p + 1] & 0xffL) | ((x[p + 2] & 0xffL) << 8)
                            | ((x[p + 3] & 0xffL) << 16) | ((x[p + 4] & 0xffL) << 24);
                    return (int) secs * 1000L;
                }
            } else if (tag == 0x000a && sz >= 32) { // NTFS timestamps
                int q = p + 4; // skip reserved
                while (q + 4 <= p + sz) {
                    int t2 = (x[q] & 0xff) | ((x[q + 1] & 0xff) << 8);
                    int s2 = (x[q + 2] & 0xff) | ((x[q + 3] & 0xff) << 8);
                    if (t2 == 1 && s2 >= 8) {
                        long v = 0;
                        for (int i = 7; i >= 0; i--) {
                            v = (v << 8) | (x[q + 4 + i] & 0xffL);
                        }
                        // 100ns units since 1601-01-01 -> millis since epoch
                        return v / 10000L - 11644473600000L;
                    }
                    q += 4 + s2;
                }
            }
            off = p + sz;
        }
        return Long.MIN_VALUE;
    }

    /** Days from 1970-01-01 for a proleptic Gregorian civil date. */
    private static long daysFromCivil(int y, int m, int d) {
        y -= m <= 2 ? 1 : 0;
        long era = (y >= 0 ? y : y - 399) / 400;
        long yoe = y - era * 400;
        long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
        long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }

    public boolean isDirectory() {
        return name.charAt(name.length() - 1) == '/';
    }

    public void setComment(String string) {
        if (string == null || string.length() <= 0xFFFF) {
            comment = string;
        } else {
            throw new IllegalArgumentException();
        }
    }

    public void setCompressedSize(long value) {
        compressedSize = value;
    }

    public void setCrc(long value) {
        if (value >= 0 && value <= 0xFFFFFFFFL) {
            crc = value;
        } else {
            throw new IllegalArgumentException();
        }
    }

    public void setExtra(byte[] data) {
        if (data == null || data.length <= 0xFFFF) {
            extra = data;
        } else {
            throw new IllegalArgumentException();
        }
    }

    public void setMethod(int value) {
        if (value != STORED && value != DEFLATED) {
            throw new IllegalArgumentException();
        }
        compressionMethod = value;
    }

    public void setSize(long value) {
        if (value >= 0 && value <= 0xFFFFFFFFL) {
            size = value;
        } else {
            throw new IllegalArgumentException();
        }
    }

    public void setTime(long value) {
        // JDK semantics: an explicit setTime(long) supersedes any FileTime
        // previously stored by setLastModifiedTime.
        shimMtimeMillis = Long.MIN_VALUE;
        setTimeInternal(value);
    }

    // --- epubcheck-standalone shim fix: NON-VIRTUAL body of setTime(), also
    // used by setLastModifiedTime(). The JDK's setLastModifiedTime writes the
    // base class's own fields directly; delegating to the VIRTUAL setTime()
    // recursed forever under commons-compress's ZipArchiveEntry, whose
    // setTime()/setExtra() overrides call back into the base-class
    // setLastModifiedTime() (epubcheck --mode exp zip writer).
    private void setTimeInternal(long value) {
        GregorianCalendar cal = new GregorianCalendar();
        cal.setTime(new Date(value));
        int year = cal.get(Calendar.YEAR);
        if (year < 1980) {
            modDate = 0x21;
            time = 0;
        } else {
            modDate = cal.get(Calendar.DATE);
            modDate = (cal.get(Calendar.MONTH) + 1 << 5) | modDate;
            modDate = ((cal.get(Calendar.YEAR) - 1980) << 9) | modDate;
            time = cal.get(Calendar.SECOND) >> 1;
            time = (cal.get(Calendar.MINUTE) << 5) | time;
            time = (cal.get(Calendar.HOUR_OF_DAY) << 11) | time;
        }
    }

    @Override
    public String toString() {
        return name;
    }

    public TZipEntry(TZipEntry ze) {
        name = ze.name;
        comment = ze.comment;
        time = ze.time;
        size = ze.size;
        compressedSize = ze.compressedSize;
        crc = ze.crc;
        compressionMethod = ze.compressionMethod;
        modDate = ze.modDate;
        extra = ze.extra;
        nameLen = ze.nameLen;
        mLocalHeaderRelOffset = ze.mLocalHeaderRelOffset;
    }

    @Override
    public Object clone() {
        return new TZipEntry(this);
    }

    /*
     * Internal constructor.  Creates a new TZipEntry by reading the
     * Central Directory Entry from "in", which must be positioned at
     * the CDE signature.
     *
     * On exit, "in" will be positioned at the start of the next entry.
     */
    TZipEntry(LittleEndianReader ler, InputStream in) throws IOException {

        /*
         * We're seeing performance issues when we call readShortLE and
         * readIntLE, so we're going to read the entire header at once
         * and then parse the results out without using any function calls.
         * Uglier, but should be much faster.
         *
         * Note that some lines look a bit different, because the corresponding
         * fields or locals are long and so we need to do & 0xffffffffl to avoid
         * problems induced by sign extension.
         */

        byte[] hdrBuf = ler.hdrBuf;
        myReadFully(in, hdrBuf);

        long sig = (hdrBuf[0] & 0xff) | ((hdrBuf[1] & 0xff) << 8)
                | ((hdrBuf[2] & 0xff) << 16) | ((hdrBuf[3] << 24) & 0xffffffffL);
        if (sig != CENSIG) {
            throw new TZipException();
        }

        compressionMethod = (hdrBuf[10] & 0xff) | ((hdrBuf[11] & 0xff) << 8);
        time = (hdrBuf[12] & 0xff) | ((hdrBuf[13] & 0xff) << 8);
        modDate = (hdrBuf[14] & 0xff) | ((hdrBuf[15] & 0xff) << 8);
        crc = (hdrBuf[16] & 0xff) | ((hdrBuf[17] & 0xff) << 8)
                | ((hdrBuf[18] & 0xff) << 16)
                | ((hdrBuf[19] << 24) & 0xffffffffL);
        compressedSize = (hdrBuf[20] & 0xff) | ((hdrBuf[21] & 0xff) << 8)
                | ((hdrBuf[22] & 0xff) << 16)
                | ((hdrBuf[23] << 24) & 0xffffffffL);
        size = (hdrBuf[24] & 0xff) | ((hdrBuf[25] & 0xff) << 8)
                | ((hdrBuf[26] & 0xff) << 16)
                | ((hdrBuf[27] << 24) & 0xffffffffL);
        nameLen = (hdrBuf[28] & 0xff) | ((hdrBuf[29] & 0xff) << 8);
        int extraLen = (hdrBuf[30] & 0xff) | ((hdrBuf[31] & 0xff) << 8);
        int commentLen = (hdrBuf[32] & 0xff) | ((hdrBuf[33] & 0xff) << 8);
        mLocalHeaderRelOffset = (hdrBuf[42] & 0xff) | ((hdrBuf[43] & 0xff) << 8)
                | ((hdrBuf[44] & 0xff) << 16)
                | ((hdrBuf[45] << 24) & 0xffffffffL);

        byte[] nameBytes = new byte[nameLen];
        myReadFully(in, nameBytes);

        // epubcheck-standalone shim fix: the central-directory record layout is
        // name, EXTRA, comment (APPNOTE 4.3.12; the JDK reads it that way).
        // Stock code read the comment before the extra field, so any entry
        // carrying both got garbage for each -- fatal once the ZIP64 extra
        // field below is load-bearing.
        if (extraLen > 0) {
            extra = new byte[extraLen];
            myReadFully(in, extra);
        }

        byte[] commentBytes = null;
        if (commentLen > 0) {
            commentBytes = new byte[commentLen];
            myReadFully(in, commentBytes);
        }

        // --- epubcheck-standalone TeaVM shim addition: ZIP64 extra field (0x0001) ---
        // In a ZIP64 archive, any central-directory field too big for its
        // 32-bit slot holds the 0xffffffff sentinel and the real 64-bit value
        // lives in the entry's ZIP64 extra field -- in fixed order
        // (uncompressed size, compressed size, local header offset), with only
        // the sentinel'd fields present (APPNOTE 4.5.3; the JDK reads it the
        // same way). Without this, entries past the 4 GiB mark point at
        // offset 0xffffffff and every read of them fails.
        if (extra != null
                && (size == 0xffffffffL || compressedSize == 0xffffffffL
                        || mLocalHeaderRelOffset == 0xffffffffL)) {
            int xoff = 0;
            while (xoff + 4 <= extra.length) {
                int tag = (extra[xoff] & 0xff) | ((extra[xoff + 1] & 0xff) << 8);
                int tagSize = (extra[xoff + 2] & 0xff) | ((extra[xoff + 3] & 0xff) << 8);
                int p = xoff + 4;
                if (p + tagSize > extra.length) {
                    break;
                }
                if (tag == 0x0001) {
                    int q = p;
                    if (size == 0xffffffffL && q + 8 <= p + tagSize) {
                        size = readLongLEArray(extra, q);
                        q += 8;
                    }
                    if (compressedSize == 0xffffffffL && q + 8 <= p + tagSize) {
                        compressedSize = readLongLEArray(extra, q);
                        q += 8;
                    }
                    if (mLocalHeaderRelOffset == 0xffffffffL && q + 8 <= p + tagSize) {
                        mLocalHeaderRelOffset = readLongLEArray(extra, q);
                        q += 8;
                    }
                    break;
                }
                xoff = p + tagSize;
            }
        }

        // --- epubcheck-standalone TeaVM shim fix (fork of the stock classlib file) ---
        // Stock code decoded names as ISO-8859-1 ("TODO: add correct UTF-8
        // support"), mojibaking every non-ASCII entry name. The JDK decodes
        // entry names as strict UTF-8 (both the no-charset ZipFile ctor and
        // the (File, UTF_8) ctor epubcheck uses) and throws
        // ZipException("invalid CEN header (bad entry name)") on malformed
        // bytes -- epubcheck maps exactly that message prefix to PKG-027.
        name = decodeNameStrictUtf8(nameBytes);
        comment = commentBytes != null ? new String(commentBytes, java.nio.charset.StandardCharsets.UTF_8) : null;
    }

    // --- epubcheck-standalone TeaVM shim addition: 64-bit little-endian array read ---
    private static long readLongLEArray(byte[] b, int off) {
        long v = 0;
        for (int i = 7; i >= 0; i--) {
            v = (v << 8) | (b[off + i] & 0xffL);
        }
        return v;
    }

    // --- epubcheck-standalone TeaVM shim addition: strict UTF-8 CEN name decoding ---
    private static String decodeNameStrictUtf8(byte[] bytes) throws TZipException {
        java.nio.charset.CharsetDecoder dec = java.nio.charset.StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT);
        try {
            return dec.decode(java.nio.ByteBuffer.wrap(bytes)).toString();
        } catch (java.nio.charset.CharacterCodingException e) {
            throw new TZipException("invalid CEN header (bad entry name)");
        }
    }

    private void myReadFully(InputStream in, byte[] b) throws IOException {
        int len = b.length;
        int off = 0;

        while (len > 0) {
            int count = in.read(b, off, len);
            if (count <= 0) {
                throw new EOFException();
            }
            off += count;
            len -= count;
        }
    }

    static long readIntLE(RandomAccessFile raf) throws IOException {
        int b0 = raf.read();
        int b1 = raf.read();
        int b2 = raf.read();
        int b3 = raf.read();

        if (b3 < 0) {
            throw new EOFException();
        }
        return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24); // ATTENTION: DOES SIGN EXTENSION: IS THIS WANTED?
    }

    static class LittleEndianReader {
        private byte[] b = new byte[4];
        byte[] hdrBuf = new byte[CENHDR];

        int readShortLE(InputStream in) throws IOException {
            if (in.read(b, 0, 2) == 2) {
                return (b[0] & 0XFF) | ((b[1] & 0XFF) << 8);
            } else {
                throw new EOFException();
            }
        }

        long readIntLE(InputStream in) throws IOException {
            if (in.read(b, 0, 4) == 4) {
                return ((b[0] & 0XFF)
                         | ((b[1] & 0XFF) << 8)
                         | ((b[2] & 0XFF) << 16)
                         | ((b[3] & 0XFF) << 24))
                       & 0XFFFFFFFFL; // Here for sure NO sign extension is wanted.
            } else {
                throw new EOFException();
            }
        }
    }

    // --- epubcheck-standalone TeaVM shim additions (fork of the stock classlib file) ---

    private org.teavm.classlib.java.nio.file.attribute.TFileTime shimCreationTime;
    private org.teavm.classlib.java.nio.file.attribute.TFileTime shimLastAccessTime;

    public TZipEntry setCreationTime(org.teavm.classlib.java.nio.file.attribute.TFileTime time) {
        this.shimCreationTime = time;
        return this;
    }

    public TZipEntry setLastAccessTime(org.teavm.classlib.java.nio.file.attribute.TFileTime time) {
        this.shimLastAccessTime = time;
        return this;
    }

    // Precise mtime stored by setLastModifiedTime (Long.MIN_VALUE = unset),
    // mirroring the JDK's ZipEntry.mtime field. Must NOT round-trip through
    // the DOS fields: java.util.zip.ZipEntry.getLastModifiedTime() returns
    // the exact FileTime that was set.
    private long shimMtimeMillis = Long.MIN_VALUE;

    public TZipEntry setLastModifiedTime(org.teavm.classlib.java.nio.file.attribute.TFileTime time) {
        // NON-VIRTUAL conversion (see setTimeInternal): the JDK's
        // setLastModifiedTime never dispatches to a subclass setTime().
        setTimeInternal(time.toMillis());
        shimMtimeMillis = time.toMillis();
        return this;
    }

    public org.teavm.classlib.java.nio.file.attribute.TFileTime getLastModifiedTime() {
        // NON-VIRTUAL read (see getTimeInternal): the JDK's
        // getLastModifiedTime never dispatches to a subclass getTime().
        long t = getTimeInternal();
        return t == -1 ? null : org.teavm.classlib.java.nio.file.attribute.TFileTime.fromMillis(t);
    }

    public org.teavm.classlib.java.nio.file.attribute.TFileTime getCreationTime() {
        return shimCreationTime;
    }

    public org.teavm.classlib.java.nio.file.attribute.TFileTime getLastAccessTime() {
        return shimLastAccessTime;
    }

}
