// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.text;

import java.util.Comparator;
import java.util.Locale;

public abstract class Collator implements Comparator<Object> {
    public static final int PRIMARY = 0;
    public static final int SECONDARY = 1;
    public static final int TERTIARY = 2;
    public static final int IDENTICAL = 3;
    public static final int NO_DECOMPOSITION = 0;
    public static final int CANONICAL_DECOMPOSITION = 1;
    public static final int FULL_DECOMPOSITION = 2;

    private int strength = TERTIARY;
    private int decomposition = CANONICAL_DECOMPOSITION;

    protected Collator() {
    }

    public static Collator getInstance() {
        return new RuleBasedCollator();
    }

    public static Collator getInstance(Locale desiredLocale) {
        return new RuleBasedCollator();
    }

    public abstract int compare(String source, String target);

    public abstract CollationKey getCollationKey(String source);

    @Override
    public int compare(Object o1, Object o2) {
        return compare((String) o1, (String) o2);
    }

    public int getStrength() {
        return strength;
    }

    public void setStrength(int newStrength) {
        strength = newStrength;
    }

    public int getDecomposition() {
        return decomposition;
    }

    public void setDecomposition(int decompositionMode) {
        decomposition = decompositionMode;
    }
}
