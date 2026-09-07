package ecshim;

import org.teavm.extension.spi.reflection.SimpleReflectionPolicy;

/**
 * Runtime-reflection surface for the epubcheck stack under TeaVM, translated
 * from the GraalVM build's native-config/reachability-metadata.json (the
 * parity-verified ground truth of what epubcheck + Xerces + Jing + Saxon
 * actually look up by name at runtime). Registered via
 * META-INF/services/org.teavm.extension.spi.reflection.ReflectionPolicy.
 */
public class EpubcheckReflectionPolicy extends SimpleReflectionPolicy {
    private static final String[] INSTANTIATED_BY_NAME = {
        // Jing service factories (looked up through META-INF/services files)
        "com.adobe.epubcheck.util.JsonWriter$OptionalJsonSerializer",
        "com.thaiopensource.datatype.xsd.DatatypeLibraryFactoryImpl",
        "com.thaiopensource.datatype.xsd.regex.java.RegexEngineImpl",
        "com.thaiopensource.validate.auto.SchemaReaderLoaderSchemaReceiverFactory",
        "com.thaiopensource.validate.mns.MnsSchemaReceiverFactory",
        "com.thaiopensource.validate.nrl.NrlSchemaReceiverFactory",
        "com.thaiopensource.validate.nvdl.NvdlSchemaReceiverFactory",
        "com.thaiopensource.validate.picl.PiclSchemaReceiverFactory",
        "com.thaiopensource.validate.rng.SAXSchemaReceiverFactory",
        // Saxon: configuration, JAXP factory, and the reflectively-built
        // XPath/XSLT function library used by the schematron pipeline
        "net.sf.saxon.Configuration",
        "net.sf.saxon.TransformerFactoryImpl",
        "net.sf.saxon.functions.BooleanFn",
        "net.sf.saxon.functions.Concat",
        "net.sf.saxon.functions.ConstantFunction$False",
        "net.sf.saxon.functions.ConstantFunction$True",
        "net.sf.saxon.functions.Contains",
        "net.sf.saxon.functions.ContextItemAccessorFunction",
        "net.sf.saxon.functions.ContextItemAccessorFunction$StringAccessor",
        "net.sf.saxon.functions.Count",
        "net.sf.saxon.functions.Current",
        "net.sf.saxon.functions.Empty",
        "net.sf.saxon.functions.Exists",
        "net.sf.saxon.functions.FunctionAvailable",
        "net.sf.saxon.functions.KeyFn",
        "net.sf.saxon.functions.LocalName_1",
        "net.sf.saxon.functions.LowerCase",
        "net.sf.saxon.functions.Matches",
        "net.sf.saxon.functions.Name_1",
        "net.sf.saxon.functions.NormalizeSpace_1",
        "net.sf.saxon.functions.NotFn",
        "net.sf.saxon.functions.Number_1",
        "net.sf.saxon.functions.PositionAndLast$Last",
        "net.sf.saxon.functions.PositionAndLast$Position",
        "net.sf.saxon.functions.RegexFunctionSansFlags",
        "net.sf.saxon.functions.Replace",
        "net.sf.saxon.functions.ResolveURI",
        "net.sf.saxon.functions.Reverse",
        "net.sf.saxon.functions.StartsWith",
        "net.sf.saxon.functions.StringJoin",
        "net.sf.saxon.functions.StringLength_1",
        "net.sf.saxon.functions.String_1",
        "net.sf.saxon.functions.Substring",
        "net.sf.saxon.functions.SubstringAfter",
        "net.sf.saxon.functions.SubstringBefore",
        "net.sf.saxon.functions.Tokenize_1",
        "net.sf.saxon.functions.Tokenize_3",
        // Xerces
        "org.apache.xerces.impl.dv.dtd.DTDDVFactoryImpl",
        "org.apache.xerces.jaxp.SAXParserFactoryImpl",
        "org.apache.xerces.parsers.XIncludeAwareParserConfiguration",
        // epubcheck's Saxon schema reader factory
        "org.idpf.epubcheck.util.saxon.SaxonSchemaReaderFactory",
        // misc
        "org.w3c.dom.Document",
        "org.xmlresolver.loaders.XmlLoader",
        // xml-apis (compiled with the ancient synthetic class$() helper, which
        // resolves the class's OWN name via Class.forName at runtime)
        "javax.xml.parsers.FactoryFinder",
        "javax.xml.transform.FactoryFinder",
        "javax.xml.datatype.FactoryFinder",
        "javax.xml.parsers.SAXParserFactory",
        "javax.xml.parsers.DocumentBuilderFactory",
        "javax.xml.transform.TransformerFactory",
        "javax.xml.datatype.DatatypeFactory",
    };

    @Override
    public boolean isClassFoundByName(org.teavm.extension.introspect.IntrospectClass<?> cls) {
        boolean r = super.isClassFoundByName(cls);
        if (cls != null && cls.name() != null && cls.name().contains("XIncludeAware")) {
            System.err.println("[ecshim] isClassFoundByName(" + cls.name() + ") = " + r);
        }
        return r;
    }

    @Override
    protected void setup() {
        System.err.println("[ecshim] EpubcheckReflectionPolicy.setup() running");
        for (String name : INSTANTIATED_BY_NAME) {
            selectClass(name).foundByName().reflectablePublicMembers();
        }
        // jackson-databind introspects the JSON report beans (fields annotated
        // @JsonProperty, private) -- expose all their members.
        selectPackage("com.adobe.epubcheck.reporting", true).reflectableMembers(member -> true);
        // CheckingReport extends MasterReport (different package), whose
        // @JsonProperty customMessageFileName field jackson also serializes.
        selectClass("com.adobe.epubcheck.api.MasterReport").reflectableMembers(member -> true);
        // CheckMessage.locations holds EPUBLocation (final class with public
        // @JsonProperty fields), whose "url" property is a galimatias URL
        // serialized through its bean getters (isOpaque/isHierarchical).
        // Without these, jackson sees no properties and writes empty {}
        // location objects.
        selectClass("com.adobe.epubcheck.api.EPUBLocation").reflectableMembers(member -> true);
        selectClass("io.mola.galimatias.URL").reflectableMembers(member -> true);
    }
}
