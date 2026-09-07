// TeaVM shim: delegates to ICU4J's Normalizer2 (present on the epubcheck
// classpath, data embedded as resources). Compiled with
// --add-reads java.base=ALL-UNNAMED so the patched java.base code may
// reference classpath classes; TeaVM has no module boundaries at runtime.
package java.text;

import com.ibm.icu.text.Normalizer2;

public final class Normalizer {
    public enum Form {
        NFC,
        NFD,
        NFKC,
        NFKD
    }

    private Normalizer() {
    }

    public static String normalize(CharSequence src, Form form) {
        return normalizer2(form).normalize(src);
    }

    public static boolean isNormalized(CharSequence src, Form form) {
        return normalizer2(form).isNormalized(src);
    }

    private static Normalizer2 normalizer2(Form form) {
        switch (form) {
            case NFC:
                return Normalizer2.getNFCInstance();
            case NFD:
                return Normalizer2.getNFDInstance();
            case NFKC:
                return Normalizer2.getNFKCInstance();
            case NFKD:
                return Normalizer2.getNFKDInstance();
            default:
                throw new IllegalArgumentException();
        }
    }
}
