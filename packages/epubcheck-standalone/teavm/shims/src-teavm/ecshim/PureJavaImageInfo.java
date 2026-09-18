package ecshim;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;

import com.adobe.epubcheck.api.EPUBLocation;
import com.adobe.epubcheck.api.Report;
import com.adobe.epubcheck.bitmap.BitmapChecker;
import com.adobe.epubcheck.messages.MessageId;
import com.adobe.epubcheck.ocf.OCFContainer;
import com.adobe.epubcheck.opf.ValidationContext;

import org.w3c.epubcheck.core.CheckerContextAccess;

import io.mola.galimatias.URL;

/**
 * Pure-Java streaming image-header reader, copied VERBATIM (logic-wise) from
 * the GraalVM wrapper's PureJavaImageSubstitution.java (parity-verified there).
 * Under TeaVM it is wired in by ecshim.BitmapCheckerTransformer, which replaces
 * BitmapChecker.getImageSizes()'s body with a call to
 * {@code PureJavaImageInfo.getImageSizes(this)} -- the exact analog of the
 * GraalVM @Substitute, with epubcheck.jar staying byte-unmodified.
 */
public final class PureJavaImageInfo {

  // AVIF/JXL dimensions live near the beginning of the file. Retain a bounded
  // prefix, then stream the remainder only to count its length.
  private static final int HEADER_LIMIT = 64 * 1024;

  private PureJavaImageInfo() {
  }

  public static BitmapChecker.ImageHeuristics getImageSizes(BitmapChecker checker) throws IOException {
    ValidationContext context = CheckerContextAccess.contextOf(checker);
    Report report = context.report;
    OCFContainer container = context.container.get();
    URL imgURL = context.url;

    int pos = imgURL.path().lastIndexOf('.');
    if (pos == -1) {
      throw new IOException("No extension for file: " + imgURL);
    }
    String suffix = imgURL.path().substring(pos + 1);

    if ("svg".compareToIgnoreCase(suffix) == 0) {
      InputStream is = container.openStream(imgURL);
      if (is == null) {
        return null;
      }
      long length;
      try {
        length = drain(is);
      } finally {
        is.close();
      }
      return checker.new ImageHeuristics(0, 0, length);
    }

    InputStream raw = container.openStream(imgURL);
    if (raw == null) {
      throw new IOException("Not a known image file: " + imgURL);
    }
    try {
      Cursor in = new Cursor(raw);
      in.fillHead();

      String formatFromStream;
      if (in.isIsoBmffCandidate()) {
        formatFromStream = sniffIsoBmff(in);
      } else {
        formatFromStream = sniffFormat(in);
        if (formatFromStream == null && in.isWbmpCandidate()) {
          formatFromStream = sniffWbmp(in);
        }
      }
      // Like the original loop: the suffix format is only computed when the
      // magic-byte sniff recognized at least one format.
      String formatFromSuffix = (formatFromStream == null) ? null : formatForSuffix(suffix);

      if (formatFromSuffix != null && formatFromSuffix.equals(formatFromStream)) {
        int width, height;
        long length;
        try {
          long[] dims = readDimensions(formatFromStream, in);
          width = (int) dims[0];
          height = (int) dims[1];
          length = in.buffered != null ? in.buffered.length : drainCursor(in);
        } catch (IOException | RuntimeException e) {
          report.message(MessageId.PKG_021, EPUBLocation.of(context));
          return null;
        }
        return checker.new ImageHeuristics(width, height, length);
      } else if (formatFromSuffix != null) {
        report.message(MessageId.PKG_022, EPUBLocation.of(context), formatFromStream, suffix);
        return null;
      } else {
        throw new IOException("Not a known image file: " + imgURL);
      }
    } finally {
      raw.close();
    }
  }

  // ---------------------------------------------------------------- sniffing

  /** Magic-byte sniff, mirroring the standard JDK reader SPIs' canDecodeInput. */
  private static String sniffFormat(Cursor in) {
    byte[] b = in.head;
    int n = in.headLen;
    if (n >= 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8'
        && (b[4] == '7' || b[4] == '9') && b[5] == 'a') {
      return "gif";
    }
    if (n >= 2 && b[0] == 0x42 && b[1] == 0x4d) {
      return "bmp";
    }
    if (n >= 4 && ((b[0] == (byte) 0x49 && b[1] == (byte) 0x49 && b[2] == (byte) 0x2a && b[3] == 0)
        || (b[0] == (byte) 0x4d && b[1] == (byte) 0x4d && b[2] == 0 && b[3] == (byte) 0x2a))) {
      return "tif";
    }
    if (n >= 8 && b[0] == (byte) 137 && b[1] == (byte) 80 && b[2] == (byte) 78 && b[3] == (byte) 71
        && b[4] == (byte) 13 && b[5] == (byte) 10 && b[6] == (byte) 26 && b[7] == (byte) 10) {
      return "png";
    }
    if (n >= 2 && b[0] == (byte) 0xFF && b[1] == (byte) 0xD8) {
      return "JPEG";
    }
    // JPEG XL naked codestream signature (ISO/IEC 18181-2, Annex A).
    if (n >= 2 && b[0] == (byte) 0xFF && b[1] == (byte) 0x0A) {
      return "jxl";
    }
    // JPEG XL container signature box.
    if (n >= 12 && u32be(b, 0) == 12 && u32be(b, 4) == fourcc("JXL ")
        && u32be(b, 8) == 0x0D0A870AL) {
      return "jxl";
    }
    return null;
  }

  /**
   * AVIF is an ISO BMFF file. Accept only an {@code ftyp} box carrying the
   * {@code avif} or {@code avis} major/compatible brand; a generic HEIF file is
   * not necessarily AVIF. Buffering this branch also lets the dimension reader
   * locate the {@code ispe} image spatial extents property without seeking.
   */
  private static String sniffIsoBmff(Cursor in) throws IOException {
    byte[] all = in.head;
    int length = in.headLen;
    if (length < 16 || u32be(all, 4) != fourcc("ftyp")) {
      return null;
    }
    long size = u32be(all, 0);
    if (size < 16 || size > length) {
      return null;
    }
    if (isAvifBrand(u32be(all, 8))) {
      return "avif";
    }
    for (int p = 16; p + 4 <= size; p += 4) {
      if (isAvifBrand(u32be(all, p))) {
        return "avif";
      }
    }
    return null;
  }

  private static boolean isAvifBrand(long brand) {
    return brand == fourcc("avif") || brand == fourcc("avis");
  }

  /**
   * WBMP has no real magic (two zero bytes), so WBMPImageReaderSpi validates the
   * whole file: multi-byte dims must be positive and the remaining data length
   * must equal ceil(width/8)*height. That needs the total length, so this rare
   * candidate path (first two bytes 0x00 0x00 -- no other format matches then)
   * buffers the file.
   */
  private static String sniffWbmp(Cursor in) throws IOException {
    byte[] all = in.bufferFully();
    int[] p = { 2 };
    long width = readMultiByte(all, p);
    long height = readMultiByte(all, p);
    if (width <= 0 || height <= 0) {
      return null;
    }
    long dataLength = (long) all.length - p[0];
    long scanSize = (width / 8) + ((width % 8) == 0 ? 0 : 1);
    if (dataLength == scanSize * height) {
      in.wbmpWidth = width;
      in.wbmpHeight = height;
      return "wbmp";
    }
    return null;
  }

  /** WBMP multi-byte integer: 7 bits per byte, high bit = continuation. */
  private static long readMultiByte(byte[] all, int[] p) throws IOException {
    long value = 0;
    while (true) {
      if (p[0] >= all.length) {
        throw new EOFException("Truncated WBMP header");
      }
      int b = all[p[0]++] & 0xff;
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) == 0) {
        return value;
      }
      if (value > Integer.MAX_VALUE) {
        return -1;
      }
    }
  }

  /** ImageIO.getImageReadersBySuffix semantics: case-insensitive SPI suffixes. */
  private static String formatForSuffix(String suffix) {
    if ("gif".equalsIgnoreCase(suffix)) return "gif";
    if ("bmp".equalsIgnoreCase(suffix)) return "bmp";
    if ("wbmp".equalsIgnoreCase(suffix)) return "wbmp";
    if ("tif".equalsIgnoreCase(suffix) || "tiff".equalsIgnoreCase(suffix)) return "tif";
    if ("png".equalsIgnoreCase(suffix)) return "png";
    if ("jpg".equalsIgnoreCase(suffix) || "jpeg".equalsIgnoreCase(suffix)) return "JPEG";
    if ("avif".equalsIgnoreCase(suffix)) return "avif";
    if ("jxl".equalsIgnoreCase(suffix)) return "jxl";
    return null;
  }

  // ------------------------------------------------------------- dimensions

  private static long[] readDimensions(String format, Cursor in) throws IOException {
    switch (format) {
      case "png":
        return pngDims(in);
      case "JPEG":
        return jpegDims(in);
      case "gif":
        return gifDims(in);
      case "bmp":
        return bmpDims(in);
      case "tif":
        return tiffDims(in);
      case "wbmp":
        return new long[] { in.wbmpWidth, in.wbmpHeight };
      case "avif":
        return avifDims(in);
      case "jxl":
        return jxlDims(in);
      default:
        throw new IOException("Unknown image format: " + format);
    }
  }

  /** AVIF: read the first valid image-spatial-extents ({@code ispe}) property. */
  private static long[] avifDims(Cursor in) throws IOException {
    long[] dims = findIspe(in.head, 0, in.headLen, 0);
    if (dims == null || dims[0] <= 0 || dims[1] <= 0) {
      throw new IOException("Missing AVIF image dimensions");
    }
    return dims;
  }

  /** Walk only ISO BMFF boxes that can contain AVIF item properties. */
  private static long[] findIspe(byte[] all, int start, int end, int depth) throws IOException {
    if (depth > 8) {
      throw new IOException("AVIF box nesting is too deep");
    }
    int p = start;
    while (p + 8 <= end) {
      long size = u32be(all, p);
      long type = u32be(all, p + 4);
      int header = 8;
      if (size == 1) {
        if (p + 16 > end) throw new IOException("Truncated AVIF extended-size box");
        long high = u32be(all, p + 8);
        long low = u32be(all, p + 12);
        if (high != 0) throw new IOException("AVIF box is too large");
        size = low;
        header = 16;
      } else if (size == 0) {
        size = end - p;
      }
      if (size < header || size > end - p) {
        throw new IOException("Invalid AVIF box size");
      }
      int boxEnd = p + (int) size;
      int payload = p + header;
      if (type == fourcc("ispe")) {
        if (payload + 12 > boxEnd) throw new IOException("Truncated AVIF ispe box");
        long width = u32be(all, payload + 4); // skip FullBox version + flags
        long height = u32be(all, payload + 8);
        return new long[] { width, height };
      }
      if (type == fourcc("meta")) {
        if (payload + 4 > boxEnd) throw new IOException("Truncated AVIF meta box");
        long[] dims = findIspe(all, payload + 4, boxEnd, depth + 1);
        if (dims != null) return dims;
      } else if (type == fourcc("iprp") || type == fourcc("ipco")) {
        long[] dims = findIspe(all, payload, boxEnd, depth + 1);
        if (dims != null) return dims;
      }
      p = boxEnd;
    }
    return null;
  }

  /** JPEG XL size header, for naked codestreams and jxlc/jxlp containers. */
  private static long[] jxlDims(Cursor in) throws IOException {
    byte[] bytes = in.head;
    int length = in.headLen;
    int codestream;
    if (length >= 2 && bytes[0] == (byte) 0xFF && bytes[1] == 0x0A) {
      codestream = 2;
    } else {
      codestream = findJxlCodestream(bytes, length);
      if (codestream < 0 || codestream + 2 > length
          || bytes[codestream] != (byte) 0xFF || bytes[codestream + 1] != 0x0A) {
        throw new IOException("Missing JPEG XL codestream");
      }
      codestream += 2;
    }
    BitCursor bits = new BitCursor(bytes, codestream, length);
    boolean small = bits.read(1) != 0;
    long height = small ? (bits.read(5) + 1L) * 8L : readJxlU32(bits);
    int ratio = (int) bits.read(3);
    long width;
    if (ratio == 0) {
      width = small ? (bits.read(5) + 1L) * 8L : readJxlU32(bits);
    } else {
      int[] numerators = { 1, 12, 4, 3, 16, 5, 2 };
      int[] denominators = { 1, 10, 3, 2, 9, 4, 1 };
      width = height * numerators[ratio - 1] / denominators[ratio - 1];
    }
    if (width <= 0 || height <= 0 || width > 0xFFFFFFFFL || height > 0xFFFFFFFFL) {
      throw new IOException("Bad JPEG XL image dimensions");
    }
    return new long[] { width, height };
  }

  private static long readJxlU32(BitCursor bits) throws IOException {
    int selector = (int) bits.read(2);
    int[] widths = { 9, 13, 18, 30 };
    return bits.read(widths[selector]) + 1L;
  }

  private static int findJxlCodestream(byte[] bytes, int length) throws IOException {
    if (length < 12 || u32be(bytes, 0) != 12 || u32be(bytes, 4) != fourcc("JXL ")
        || u32be(bytes, 8) != 0x0D0A870AL) return -1;
    int p = 12;
    while (p + 8 <= length) {
      long size = u32be(bytes, p);
      long type = u32be(bytes, p + 4);
      int header = 8;
      if (size == 1) {
        if (p + 16 > length) throw new IOException("Truncated JPEG XL box");
        if (u32be(bytes, p + 8) != 0) throw new IOException("JPEG XL box is too large");
        size = u32be(bytes, p + 12);
        header = 16;
      } else if (size == 0) {
        size = length - p;
      }
      if (size < header || size > length - p) throw new IOException("Invalid JPEG XL box size");
      int payload = p + header;
      if (type == fourcc("jxlc")) return payload;
      if (type == fourcc("jxlp")) {
        if (payload + 4 > p + size) throw new IOException("Truncated JPEG XL partial box");
        return payload + 4;
      }
      p += (int) size;
    }
    return -1;
  }

  /** JPEG XL bit fields are packed least-significant bit first. */
  private static final class BitCursor {
    private final byte[] bytes;
    private final int end;
    private int bit;

    BitCursor(byte[] bytes, int start, int end) {
      this.bytes = bytes;
      this.bit = start * 8;
      this.end = end * 8;
    }

    long read(int count) throws IOException {
      if (count < 0 || count > 32 || bit + count > end) {
        throw new EOFException("Truncated JPEG XL size header");
      }
      long value = 0;
      for (int i = 0; i < count; i++, bit++) {
        value |= (long) ((bytes[bit >>> 3] >>> (bit & 7)) & 1) << i;
      }
      return value;
    }
  }

  private static long fourcc(String value) {
    return ((long) value.charAt(0) << 24)
        | ((long) value.charAt(1) << 16)
        | ((long) value.charAt(2) << 8)
        | value.charAt(3);
  }

  private static long u32be(byte[] bytes, int offset) {
    return ((long) (bytes[offset] & 0xff) << 24)
        | ((long) (bytes[offset + 1] & 0xff) << 16)
        | ((long) (bytes[offset + 2] & 0xff) << 8)
        | (bytes[offset + 3] & 0xffL);
  }

  // Focused package-private seam for the JVM test harness. Production calls
  // follow the same sniff/suffix/dimension path above.
  static long[] inspectForTesting(byte[] bytes, String suffix) throws IOException {
    Cursor in = new Cursor(new java.io.ByteArrayInputStream(bytes));
    in.fillHead();
    String format;
    if (in.isIsoBmffCandidate()) {
      format = sniffIsoBmff(in);
    } else {
      format = sniffFormat(in);
      if (format == null && in.isWbmpCandidate()) {
        format = sniffWbmp(in);
      }
    }
    String expected = formatForSuffix(suffix);
    if (format == null || !format.equals(expected)) {
      throw new IOException("Image format does not match suffix");
    }
    return readDimensions(format, in);
  }

  /** PNG: 8-byte signature, then the IHDR chunk (mirrors PNGImageReader.readHeader). */
  private static long[] pngDims(Cursor in) throws IOException {
    in.skipFully(8);
    if (in.i32be() != 13) {
      throw new IOException("Bad length for IHDR chunk!");
    }
    if (in.i32be() != 0x49484452) { // "IHDR"
      throw new IOException("Bad type for IHDR chunk!");
    }
    int width = in.i32be();
    int height = in.i32be();
    if (width <= 0 || height <= 0) {
      throw new IOException("Bad PNG image dimensions");
    }
    return new long[] { width, height };
  }

  /**
   * JPEG: walk marker segments from SOI to the first SOFn (n in C0..CF minus
   * C4/C8/CC). APPn segments (EXIF, JFIF, ICC, ...) are skipped by length.
   */
  private static long[] jpegDims(Cursor in) throws IOException {
    in.skipFully(2); // SOI
    while (true) {
      int b = in.u8();
      if (b != 0xFF) {
        throw new IOException("Invalid JPEG marker");
      }
      int marker = in.u8();
      while (marker == 0xFF) { // fill bytes
        marker = in.u8();
      }
      if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0xD8) {
        continue; // standalone markers (TEM, RSTn, stray SOI)
      }
      if (marker == 0xD9) { // EOI before any SOF
        throw new IOException("No SOF segment in JPEG stream");
      }
      int len = in.u16be();
      if (len < 2) {
        throw new IOException("Invalid JPEG segment length");
      }
      boolean isSof = marker >= 0xC0 && marker <= 0xCF
          && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
      if (isSof) {
        if (len < 7) {
          throw new IOException("Truncated JPEG SOF segment");
        }
        in.u8(); // sample precision
        int height = in.u16be();
        int width = in.u16be();
        in.skipFully(len - 7);
        return new long[] { width, height };
      }
      in.skipFully(len - 2);
    }
  }

  /**
   * GIF: logical screen descriptor + global color table, then blocks until the
   * first image descriptor; its width/height are returned (GIFImageReader
   * reports the first frame's size, not the logical screen size).
   */
  private static long[] gifDims(Cursor in) throws IOException {
    in.skipFully(6); // "GIF87a"/"GIF89a"
    in.u16le(); // logical screen width
    in.u16le(); // logical screen height
    int packed = in.u8();
    in.u8(); // background color index
    in.u8(); // pixel aspect ratio
    if ((packed & 0x80) != 0) {
      in.skipFully(3L << ((packed & 0x07) + 1)); // global color table
    }
    while (true) {
      int block = in.u8();
      if (block == 0x2C) { // image descriptor
        in.skipFully(4); // left, top
        int width = in.u16le();
        int height = in.u16le();
        return new long[] { width, height };
      } else if (block == 0x21) { // extension
        in.u8(); // label
        int len;
        while ((len = in.u8()) > 0) {
          in.skipFully(len);
        }
      } else if (block == 0x3B) { // trailer before any image
        throw new IOException("No image in GIF stream");
      } else {
        throw new IOException("Unexpected GIF block type " + block);
      }
    }
  }

  /** BMP: BITMAPCOREHEADER (12) has u16 dims; later headers have i32 dims. */
  private static long[] bmpDims(Cursor in) throws IOException {
    in.skipFully(14); // "BM" + file size + reserved + data offset
    long headerSize = in.u32le();
    long width;
    long height;
    if (headerSize == 12) {
      width = in.u16le();
      height = in.u16le();
    } else {
      width = in.i32le();
      height = Math.abs((long) in.i32le()); // negative = top-down DIB
    }
    if (width <= 0 || height <= 0) {
      throw new IOException("Bad BMP image dimensions");
    }
    return new long[] { width, height };
  }

  /** TIFF: first IFD, tags 256 (ImageWidth) and 257 (ImageLength). */
  private static long[] tiffDims(Cursor in) throws IOException {
    boolean le = in.head[0] == (byte) 0x49;
    in.skipFully(4);
    long ifdOffset = le ? in.u32le() : in.u32be();
    if (ifdOffset < 8) {
      throw new IOException("Bad TIFF IFD offset");
    }
    in.skipFully(ifdOffset - 8);
    int entries = le ? in.u16le() : in.u16be();
    long width = -1;
    long height = -1;
    for (int i = 0; i < entries; i++) {
      int tag = le ? in.u16le() : in.u16be();
      int type = le ? in.u16le() : in.u16be();
      long count = le ? in.u32le() : in.u32be();
      long value = -1;
      if (count == 1 && type == 3) { // SHORT
        value = le ? in.u16le() : in.u16be();
        in.skipFully(2);
      } else if (count == 1 && type == 4) { // LONG
        value = le ? in.u32le() : in.u32be();
      } else {
        in.skipFully(4);
      }
      if (tag == 256) {
        width = value;
      } else if (tag == 257) {
        height = value;
      }
    }
    if (width <= 0 || height <= 0) {
      throw new IOException("Missing TIFF image dimensions");
    }
    return new long[] { width, height };
  }

  // ------------------------------------------------------------------ plumbing

  private static long drain(InputStream is) throws IOException {
    byte[] scratch = new byte[64 * 1024];
    long total = 0;
    int n;
    while ((n = is.read(scratch)) > 0) {
      total += n;
    }
    return total;
  }

  private static long drainCursor(Cursor in) throws IOException {
    in.drainToEnd();
    return in.count;
  }

  /**
   * Single-pass reader: buffers a bounded header prefix for sniffing, then serves
   * sequential reads (head first, then the stream) while counting every byte,
   * so the total resource length is known once the stream is drained.
   */
  private static final class Cursor {
    final InputStream in;
    final byte[] head = new byte[HEADER_LIMIT];
    int headLen;
    int pos; // read position within head
    long count; // total bytes consumed from the underlying stream
    byte[] buffered; // whole file, only for the rare WBMP-candidate path
    int bufferedPos;
    long wbmpWidth = -1;
    long wbmpHeight = -1;

    Cursor(InputStream in) {
      this.in = in;
    }

    void fillHead() throws IOException {
      while (headLen < head.length) {
        int n = in.read(head, headLen, head.length - headLen);
        if (n <= 0) {
          break;
        }
        headLen += n;
      }
      count = headLen;
    }

    boolean isWbmpCandidate() {
      return headLen >= 2 && head[0] == 0 && head[1] == 0;
    }

    boolean isIsoBmffCandidate() {
      return headLen >= 8 && PureJavaImageInfo.u32be(head, 4) == fourcc("ftyp");
    }

    byte[] bufferFully() throws IOException {
      if (buffered != null) {
        return buffered;
      }
      java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
      bos.write(head, 0, headLen);
      byte[] scratch = new byte[64 * 1024];
      int n;
      while ((n = in.read(scratch)) > 0) {
        bos.write(scratch, 0, n);
      }
      buffered = bos.toByteArray();
      count = buffered.length;
      return buffered;
    }

    int next() throws IOException {
      if (buffered != null) {
        return bufferedPos < buffered.length ? (buffered[bufferedPos++] & 0xff) : -1;
      }
      if (pos < headLen) {
        return head[pos++] & 0xff;
      }
      int b = in.read();
      if (b >= 0) {
        count++;
      }
      return b;
    }

    int u8() throws IOException {
      int b = next();
      if (b < 0) {
        throw new EOFException("Unexpected end of image stream");
      }
      return b;
    }

    int u16be() throws IOException {
      return (u8() << 8) | u8();
    }

    int u16le() throws IOException {
      return u8() | (u8() << 8);
    }

    int i32be() throws IOException {
      return (u8() << 24) | (u8() << 16) | (u8() << 8) | u8();
    }

    int i32le() throws IOException {
      return u8() | (u8() << 8) | (u8() << 16) | (u8() << 24);
    }

    long u32be() throws IOException {
      return ((long) i32be()) & 0xFFFFFFFFL;
    }

    long u32le() throws IOException {
      return ((long) i32le()) & 0xFFFFFFFFL;
    }

    void skipFully(long n) throws IOException {
      while (n > 0 && (buffered != null ? bufferedPos < buffered.length : pos < headLen)) {
        u8();
        n--;
      }
      byte[] scratch = null;
      while (n > 0) {
        if (buffered != null) {
          throw new EOFException("Unexpected end of image stream");
        }
        long skipped = in.skip(n);
        if (skipped > 0) {
          count += skipped;
          n -= skipped;
          continue;
        }
        // skip() made no progress; fall back to reading
        if (scratch == null) {
          scratch = new byte[8 * 1024];
        }
        int r = in.read(scratch, 0, (int) Math.min(scratch.length, n));
        if (r <= 0) {
          throw new EOFException("Unexpected end of image stream");
        }
        count += r;
        n -= r;
      }
    }

    void drainToEnd() throws IOException {
      while (pos < headLen) {
        pos++;
      }
      byte[] scratch = new byte[64 * 1024];
      int n;
      while ((n = in.read(scratch)) > 0) {
        count += n;
      }
    }
  }
}
