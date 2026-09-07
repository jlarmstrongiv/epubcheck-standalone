// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.text;

/** Codepoint-order stand-in; real collation rules are not supported. */
public class RuleBasedCollator extends Collator {
    RuleBasedCollator() {
    }

    public RuleBasedCollator(String rules) {
    }

    @Override
    public int compare(String source, String target) {
        return source.compareTo(target);
    }

    @Override
    public CollationKey getCollationKey(String source) {
        return new CollationKey(source) {
            @Override
            public byte[] toByteArray() {
                return getSourceString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            }

            @Override
            public int compareTo(CollationKey other) {
                return getSourceString().compareTo(other.getSourceString());
            }
        };
    }

    public CollationElementIterator getCollationElementIterator(String source) {
        return new CollationElementIterator();
    }
}
