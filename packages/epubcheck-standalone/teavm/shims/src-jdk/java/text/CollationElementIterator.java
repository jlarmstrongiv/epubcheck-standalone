// TeaVM shim: existence stub for code paths epubcheck validation never executes.
package java.text;

public final class CollationElementIterator {
    public static final int NULLORDER = -1;

    CollationElementIterator() {
    }

    public int next() {
        return NULLORDER;
    }

    public void reset() {
    }

    public int getOffset() {
        return 0;
    }

    public void setOffset(int newOffset) {
    }

    public static int primaryOrder(int order) {
        return order >>> 16;
    }

    public static short secondaryOrder(int order) {
        return (short) ((order >>> 8) & 0xff);
    }

    public static short tertiaryOrder(int order) {
        return (short) (order & 0xff);
    }
}
