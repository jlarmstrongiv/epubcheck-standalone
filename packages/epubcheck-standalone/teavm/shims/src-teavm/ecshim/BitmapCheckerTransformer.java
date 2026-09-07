package ecshim;

import org.teavm.model.ClassHolder;
import org.teavm.model.ClassHolderTransformer;
import org.teavm.model.ClassHolderTransformerContext;
import org.teavm.model.MethodHolder;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.model.emit.ValueEmitter;

/**
 * Replaces com.adobe.epubcheck.bitmap.BitmapChecker.getImageSizes()'s body with
 * {@code return ecshim.PureJavaImageInfo.getImageSizes(this);} -- the TeaVM
 * analog of the GraalVM wrapper's @Substitute
 * (PureJavaImageSubstitution.java). javax.imageio never becomes reachable and
 * image checks keep jar parity via the pure-Java header reader.
 */
public class BitmapCheckerTransformer implements ClassHolderTransformer {
    private static final String BITMAP_CHECKER = "com.adobe.epubcheck.bitmap.BitmapChecker";
    private static final String HEURISTICS = "com.adobe.epubcheck.bitmap.BitmapChecker$ImageHeuristics";

    @Override
    public void transformClass(ClassHolder cls, ClassHolderTransformerContext context) {
        if (!cls.getName().equals(BITMAP_CHECKER)) {
            return;
        }
        for (MethodHolder method : cls.getMethods()) {
            if (method.getName().equals("getImageSizes") && method.parameterCount() == 0) {
                ProgramEmitter pe = ProgramEmitter.create(method, context.getHierarchy());
                ValueEmitter self = pe.var(0, ValueType.object(BITMAP_CHECKER));
                pe.invoke("ecshim.PureJavaImageInfo", "getImageSizes",
                        ValueType.object(HEURISTICS), self).returnValue();
            }
        }
    }
}
