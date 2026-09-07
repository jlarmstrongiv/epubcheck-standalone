package ecshim;

import org.teavm.model.ClassHolder;
import org.teavm.model.ClassHolderTransformer;
import org.teavm.model.ClassHolderTransformerContext;
import org.teavm.model.MethodHolder;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;

/**
 * Hard-wires the JAXP factory lookups to the exact implementations the
 * official epubcheck jar resolves through META-INF/services:
 *   SAXParserFactory.newInstance()      -> org.apache.xerces.jaxp.SAXParserFactoryImpl
 *   DocumentBuilderFactory.newInstance()-> org.apache.xerces.jaxp.DocumentBuilderFactoryImpl
 *   TransformerFactory.newInstance()    -> net.sf.saxon.TransformerFactoryImpl
 *
 * WHY: xml-apis' FactoryFinder is compiled with the ancient synthetic
 * class$() helper that calls Class.forName on its own class name at runtime;
 * TeaVM's reflection registry does not serve javax.xml.* names (the classlib
 * substitution scope claims that namespace), so the finder dies with
 * NoClassDefFoundError. Replacing the three newInstance() bodies removes the
 * whole dynamic-lookup machinery while producing the identical factories.
 */
public class JaxpWiringTransformer implements ClassHolderTransformer {
    @Override
    public void transformClass(ClassHolder cls, ClassHolderTransformerContext context) {
        switch (cls.getName()) {
            case "javax.xml.parsers.SAXParserFactory":
                wire(cls, context, "newInstance", "org.apache.xerces.jaxp.SAXParserFactoryImpl");
                break;
            case "javax.xml.parsers.DocumentBuilderFactory":
                wire(cls, context, "newInstance", "org.apache.xerces.jaxp.DocumentBuilderFactoryImpl");
                break;
            case "javax.xml.transform.TransformerFactory":
                wire(cls, context, "newInstance", "net.sf.saxon.TransformerFactoryImpl");
                break;
            default:
        }
    }

    private void wire(ClassHolder cls, ClassHolderTransformerContext context, String methodName,
            String implClass) {
        for (MethodHolder method : cls.getMethods()) {
            if (method.getName().equals(methodName) && method.parameterCount() == 0
                    && method.hasModifier(org.teavm.model.ElementModifier.STATIC)) {
                ProgramEmitter pe = ProgramEmitter.create(method, context.getHierarchy());
                pe.construct(implClass).returnValue();
            }
        }
    }
}
