package ecshim;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

/** Focused JVM checks for image formats whose readers are supplied by our shim. */
public final class PureJavaImageInfoTest {
  public static void main(String[] args) throws Exception {
    byte[] avif = box("ftyp", concat(ascii("avif"), u32(0), ascii("mif1"), ascii("avif")));
    byte[] ispe = box("ispe", concat(u32(0), u32(40), u32(55)));
    byte[] ipco = box("ipco", ispe);
    byte[] iprp = box("iprp", ipco);
    byte[] meta = box("meta", concat(u32(0), iprp));
    long[] avifDims = PureJavaImageInfo.inspectForTesting(concat(avif, meta), "avif");
    assertDimensions("AVIF", avifDims, 40, 55);

    // A compatible AVIF brand is sufficient even when the major brand is MIF1.
    byte[] compatibleAvif = box("ftyp", concat(ascii("mif1"), u32(0), ascii("avif")));
    long[] compatibleDims = PureJavaImageInfo.inspectForTesting(concat(compatibleAvif, meta), "AVIF");
    assertDimensions("compatible-brand AVIF", compatibleDims, 40, 55);

    byte[] codestream = jxlCodestream(40, 56);
    long[] nakedJxl = PureJavaImageInfo.inspectForTesting(codestream, "jxl");
    assertDimensions("naked JXL", nakedJxl, 40, 56);

    byte[] containerJxl = concat(
        u32(12), ascii("JXL "), new byte[] { 0x0D, 0x0A, (byte) 0x87, 0x0A },
        box("ftyp", concat(ascii("jxl "), u32(0), ascii("jxl "))),
        box("jxlc", codestream));
    long[] containerDims = PureJavaImageInfo.inspectForTesting(containerJxl, "JXL");
    assertDimensions("container JXL", containerDims, 40, 56);

    expectFailure("mislabeled WebP/JXL", new byte[] {
        'R', 'I', 'F', 'F', 4, 0, 0, 0, 'W', 'E', 'B', 'P'
    }, "jxl");
    expectFailure("truncated AVIF", avif, "avif");
    expectFailure("oversized AVIF box", concat(avif, u32(1000), ascii("meta")), "avif");
    expectFailure("truncated JXL size header", new byte[] { (byte) 0xFF, 0x0A }, "jxl");
    System.out.println("ok PureJavaImageInfo AVIF/JXL");
  }

  private static void assertDimensions(String label, long[] actual, long width, long height) {
    if (actual[0] != width || actual[1] != height) {
      throw new AssertionError(label + ": expected " + width + "x" + height
          + ", got " + actual[0] + "x" + actual[1]);
    }
  }

  private static void expectFailure(String label, byte[] bytes, String suffix) throws Exception {
    try {
      PureJavaImageInfo.inspectForTesting(bytes, suffix);
      throw new AssertionError(label + ": expected IOException");
    } catch (IOException expected) {
      // expected
    }
  }

  private static byte[] box(String type, byte[] payload) {
    return concat(u32(8 + payload.length), ascii(type), payload);
  }

  /** Small-size JXL header: small bit, y/8-1, ratio=0, x/8-1 (LSB first). */
  private static byte[] jxlCodestream(int width, int height) {
    if (width % 8 != 0 || height % 8 != 0 || width > 256 || height > 256) {
      throw new IllegalArgumentException("test helper only supports small JXL dimensions");
    }
    int fields = 1 | ((height / 8 - 1) << 1) | ((width / 8 - 1) << 9);
    return new byte[] {
        (byte) 0xFF, 0x0A, (byte) fields, (byte) (fields >>> 8)
    };
  }

  private static byte[] u32(long value) {
    return new byte[] {
        (byte) (value >>> 24), (byte) (value >>> 16), (byte) (value >>> 8), (byte) value
    };
  }

  private static byte[] ascii(String value) {
    byte[] bytes = new byte[value.length()];
    for (int i = 0; i < value.length(); i++) bytes[i] = (byte) value.charAt(i);
    return bytes;
  }

  private static byte[] concat(byte[]... parts) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (byte[] part : parts) out.write(part, 0, part.length);
    return out.toByteArray();
  }
}
