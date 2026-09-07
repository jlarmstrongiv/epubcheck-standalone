// TeaVM shim: existence stub for code paths epubcheck validation never executes.
package java.text;

public abstract class CollationKey implements Comparable<CollationKey> {
    private final String source;

    protected CollationKey(String source) {
        this.source = source;
    }

    public String getSourceString() {
        return source;
    }

    public abstract byte[] toByteArray();

    @Override
    public abstract int compareTo(CollationKey target);
}
