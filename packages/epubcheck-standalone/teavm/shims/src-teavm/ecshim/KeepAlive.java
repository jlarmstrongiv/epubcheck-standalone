package ecshim;

import org.teavm.jso.JSBody;

/**
 * Forces static reachability of every class the epubcheck stack instantiates
 * REFLECTIVELY at runtime (translated from the GraalVM build's
 * reachability-metadata.json). TeaVM's ReflectionPolicy can only mark
 * reachable classes as findable-by-name -- it does not compile classes nothing
 * references -- so the wrapper calls {@link #keep()} behind a JS-opaque
 * condition that is always false at runtime.
 */
public final class KeepAlive {
    private KeepAlive() {
    }

    @JSBody(script = "return globalThis.__ecNeverTrue === 'no-such-value';")
    private static native boolean neverTrue();

    @JSBody(params = { "o" }, script = "globalThis.__ecKeepSink = o;")
    private static native void sink(Object o);

    public static void keep() throws Exception {
        if (!neverTrue()) {
            return;
        }
        Object[] all = {
        // Jing service factories
        new com.thaiopensource.datatype.xsd.DatatypeLibraryFactoryImpl(),
        new com.thaiopensource.datatype.xsd.regex.java.RegexEngineImpl(),
        new com.thaiopensource.validate.auto.SchemaReaderLoaderSchemaReceiverFactory(),
        new com.thaiopensource.validate.mns.MnsSchemaReceiverFactory(),
        new com.thaiopensource.validate.nrl.NrlSchemaReceiverFactory(),
        new com.thaiopensource.validate.nvdl.NvdlSchemaReceiverFactory(),
        new com.thaiopensource.validate.picl.PiclSchemaReceiverFactory(),
        new com.thaiopensource.validate.rng.SAXSchemaReceiverFactory(),
        // Saxon
        new net.sf.saxon.Configuration(),
        new net.sf.saxon.TransformerFactoryImpl(),
        new net.sf.saxon.functions.BooleanFn(),
        new net.sf.saxon.functions.Concat(),
        new net.sf.saxon.functions.ConstantFunction.False(),
        new net.sf.saxon.functions.ConstantFunction.True(),
        new net.sf.saxon.functions.Contains(),
        new net.sf.saxon.functions.ContextItemAccessorFunction(),
        new net.sf.saxon.functions.ContextItemAccessorFunction.StringAccessor(),
        new net.sf.saxon.functions.Count(),
        new net.sf.saxon.functions.Current(),
        new net.sf.saxon.functions.Empty(),
        new net.sf.saxon.functions.Exists(),
        new net.sf.saxon.functions.FunctionAvailable(),
        new net.sf.saxon.functions.KeyFn(),
        new net.sf.saxon.functions.LocalName_1(),
        new net.sf.saxon.functions.LowerCase(),
        new net.sf.saxon.functions.Matches(),
        new net.sf.saxon.functions.Name_1(),
        new net.sf.saxon.functions.NormalizeSpace_1(),
        new net.sf.saxon.functions.NotFn(),
        new net.sf.saxon.functions.Number_1(),
        new net.sf.saxon.functions.PositionAndLast.Last(),
        new net.sf.saxon.functions.PositionAndLast.Position(),
        new net.sf.saxon.functions.RegexFunctionSansFlags(),
        new net.sf.saxon.functions.Replace(),
        new net.sf.saxon.functions.ResolveURI(),
        new net.sf.saxon.functions.Reverse(),
        new net.sf.saxon.functions.StartsWith(),
        new net.sf.saxon.functions.StringJoin(),
        new net.sf.saxon.functions.StringLength_1(),
        new net.sf.saxon.functions.String_1(),
        new net.sf.saxon.functions.Substring(),
        new net.sf.saxon.functions.SubstringAfter(),
        new net.sf.saxon.functions.SubstringBefore(),
        new net.sf.saxon.functions.Tokenize_1(),
        new net.sf.saxon.functions.Tokenize_3(),
        // Xerces
        new org.apache.xerces.impl.dv.dtd.DTDDVFactoryImpl(),
        new org.apache.xerces.jaxp.SAXParserFactoryImpl(),
        new org.apache.xerces.parsers.XIncludeAwareParserConfiguration(),
        // epubcheck's Saxon schema reader factory
        new org.idpf.epubcheck.util.saxon.SaxonSchemaReaderFactory(),
        // xmlresolver catalog loader (constructed reflectively with the config)
        new org.xmlresolver.loaders.XmlLoader((org.xmlresolver.ResolverConfiguration) null),
        };
        sink(all);
        // Class-literal getName calls: TeaVM emits runtime class-name metadata
        // (which backs Class.forName's name map) only for classes whose Class
        // values flow into getName() call sites.
        sink(com.adobe.epubcheck.util.JsonWriter.OptionalJsonSerializer.class.getName());
        sink(com.thaiopensource.datatype.xsd.DatatypeLibraryFactoryImpl.class.getName());
        sink(com.thaiopensource.datatype.xsd.regex.java.RegexEngineImpl.class.getName());
        sink(com.thaiopensource.validate.auto.SchemaReaderLoaderSchemaReceiverFactory.class.getName());
        sink(com.thaiopensource.validate.mns.MnsSchemaReceiverFactory.class.getName());
        sink(com.thaiopensource.validate.nrl.NrlSchemaReceiverFactory.class.getName());
        sink(com.thaiopensource.validate.nvdl.NvdlSchemaReceiverFactory.class.getName());
        sink(com.thaiopensource.validate.picl.PiclSchemaReceiverFactory.class.getName());
        sink(com.thaiopensource.validate.rng.SAXSchemaReceiverFactory.class.getName());
        sink(net.sf.saxon.Configuration.class.getName());
        sink(net.sf.saxon.TransformerFactoryImpl.class.getName());
        sink(net.sf.saxon.functions.BooleanFn.class.getName());
        sink(net.sf.saxon.functions.Concat.class.getName());
        sink(net.sf.saxon.functions.ConstantFunction.False.class.getName());
        sink(net.sf.saxon.functions.ConstantFunction.True.class.getName());
        sink(net.sf.saxon.functions.Contains.class.getName());
        sink(net.sf.saxon.functions.ContextItemAccessorFunction.class.getName());
        sink(net.sf.saxon.functions.ContextItemAccessorFunction.StringAccessor.class.getName());
        sink(net.sf.saxon.functions.Count.class.getName());
        sink(net.sf.saxon.functions.Current.class.getName());
        sink(net.sf.saxon.functions.Empty.class.getName());
        sink(net.sf.saxon.functions.Exists.class.getName());
        sink(net.sf.saxon.functions.FunctionAvailable.class.getName());
        sink(net.sf.saxon.functions.KeyFn.class.getName());
        sink(net.sf.saxon.functions.LocalName_1.class.getName());
        sink(net.sf.saxon.functions.LowerCase.class.getName());
        sink(net.sf.saxon.functions.Matches.class.getName());
        sink(net.sf.saxon.functions.Name_1.class.getName());
        sink(net.sf.saxon.functions.NormalizeSpace_1.class.getName());
        sink(net.sf.saxon.functions.NotFn.class.getName());
        sink(net.sf.saxon.functions.Number_1.class.getName());
        sink(net.sf.saxon.functions.PositionAndLast.Last.class.getName());
        sink(net.sf.saxon.functions.PositionAndLast.Position.class.getName());
        sink(net.sf.saxon.functions.RegexFunctionSansFlags.class.getName());
        sink(net.sf.saxon.functions.Replace.class.getName());
        sink(net.sf.saxon.functions.ResolveURI.class.getName());
        sink(net.sf.saxon.functions.Reverse.class.getName());
        sink(net.sf.saxon.functions.StartsWith.class.getName());
        sink(net.sf.saxon.functions.StringJoin.class.getName());
        sink(net.sf.saxon.functions.StringLength_1.class.getName());
        sink(net.sf.saxon.functions.String_1.class.getName());
        sink(net.sf.saxon.functions.Substring.class.getName());
        sink(net.sf.saxon.functions.SubstringAfter.class.getName());
        sink(net.sf.saxon.functions.SubstringBefore.class.getName());
        sink(net.sf.saxon.functions.Tokenize_1.class.getName());
        sink(net.sf.saxon.functions.Tokenize_3.class.getName());
        sink(org.apache.xerces.impl.dv.dtd.DTDDVFactoryImpl.class.getName());
        sink(org.apache.xerces.jaxp.SAXParserFactoryImpl.class.getName());
        sink(org.apache.xerces.parsers.XIncludeAwareParserConfiguration.class.getName());
        sink(org.idpf.epubcheck.util.saxon.SaxonSchemaReaderFactory.class.getName());
        sink(org.w3c.dom.Document.class.getName());
        sink(org.xmlresolver.loaders.XmlLoader.class.getName());
        sink(javax.xml.parsers.SAXParserFactory.class.getName());
        sink(javax.xml.parsers.DocumentBuilderFactory.class.getName());
        sink(javax.xml.transform.TransformerFactory.class.getName());
        sink(javax.xml.datatype.DatatypeFactory.class.getName());
        // Reflective-constructor chains on class literals: TeaVM emits
        // constructor reflection metadata only for classes whose Class values
        // flow into getConstructor/newInstance call sites.
        sink(com.thaiopensource.datatype.xsd.DatatypeLibraryFactoryImpl.class.getDeclaredConstructor().newInstance());
        sink(com.thaiopensource.datatype.xsd.regex.java.RegexEngineImpl.class.getDeclaredConstructor().newInstance());
        sink(com.thaiopensource.validate.auto.SchemaReaderLoaderSchemaReceiverFactory.class.getDeclaredConstructor().newInstance());
        sink(com.thaiopensource.validate.mns.MnsSchemaReceiverFactory.class.getDeclaredConstructor().newInstance());
        sink(com.adobe.epubcheck.util.JsonWriter.OptionalJsonSerializer.class.getDeclaredConstructor().newInstance());
        sink(com.thaiopensource.validate.nrl.NrlSchemaReceiverFactory.class.getDeclaredConstructor().newInstance());
        sink(com.thaiopensource.validate.nvdl.NvdlSchemaReceiverFactory.class.getDeclaredConstructor().newInstance());
        sink(com.thaiopensource.validate.picl.PiclSchemaReceiverFactory.class.getDeclaredConstructor().newInstance());
        sink(com.thaiopensource.validate.rng.SAXSchemaReceiverFactory.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.Configuration.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.TransformerFactoryImpl.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.BooleanFn.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Concat.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.ConstantFunction.False.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.ConstantFunction.True.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Contains.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.ContextItemAccessorFunction.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.ContextItemAccessorFunction.StringAccessor.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Count.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Current.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Empty.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Exists.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.FunctionAvailable.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.KeyFn.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.LocalName_1.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.LowerCase.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Matches.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Name_1.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.NormalizeSpace_1.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.NotFn.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Number_1.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.PositionAndLast.Last.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.PositionAndLast.Position.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.RegexFunctionSansFlags.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Replace.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.ResolveURI.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Reverse.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.StartsWith.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.StringJoin.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.StringLength_1.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.String_1.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Substring.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.SubstringAfter.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.SubstringBefore.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Tokenize_1.class.getDeclaredConstructor().newInstance());
        sink(net.sf.saxon.functions.Tokenize_3.class.getDeclaredConstructor().newInstance());
        sink(org.apache.xerces.impl.dv.dtd.DTDDVFactoryImpl.class.getDeclaredConstructor().newInstance());
        sink(org.apache.xerces.jaxp.SAXParserFactoryImpl.class.getDeclaredConstructor().newInstance());
        sink(org.apache.xerces.parsers.XIncludeAwareParserConfiguration.class.getDeclaredConstructor().newInstance());
        sink(org.idpf.epubcheck.util.saxon.SaxonSchemaReaderFactory.class.getDeclaredConstructor().newInstance());
        sink(org.xmlresolver.loaders.XmlLoader.class.getConstructor(org.xmlresolver.ResolverConfiguration.class).newInstance((Object) null));
        // Literal-constant Class.forName calls: TeaVM's dependency analysis
        // registers name->class mappings from constant strings flowing into
        // forName, which is what makes runtime by-name lookups succeed.
        sink(Class.forName("com.adobe.epubcheck.util.JsonWriter$OptionalJsonSerializer"));
        sink(Class.forName("com.thaiopensource.datatype.xsd.DatatypeLibraryFactoryImpl"));
        sink(Class.forName("com.thaiopensource.datatype.xsd.regex.java.RegexEngineImpl"));
        sink(Class.forName("com.thaiopensource.validate.auto.SchemaReaderLoaderSchemaReceiverFactory"));
        sink(Class.forName("com.thaiopensource.validate.mns.MnsSchemaReceiverFactory"));
        sink(Class.forName("com.thaiopensource.validate.nrl.NrlSchemaReceiverFactory"));
        sink(Class.forName("com.thaiopensource.validate.nvdl.NvdlSchemaReceiverFactory"));
        sink(Class.forName("com.thaiopensource.validate.picl.PiclSchemaReceiverFactory"));
        sink(Class.forName("com.thaiopensource.validate.rng.SAXSchemaReceiverFactory"));
        sink(Class.forName("net.sf.saxon.Configuration"));
        sink(Class.forName("net.sf.saxon.TransformerFactoryImpl"));
        sink(Class.forName("net.sf.saxon.functions.BooleanFn"));
        sink(Class.forName("net.sf.saxon.functions.Concat"));
        sink(Class.forName("net.sf.saxon.functions.ConstantFunction$False"));
        sink(Class.forName("net.sf.saxon.functions.ConstantFunction$True"));
        sink(Class.forName("net.sf.saxon.functions.Contains"));
        sink(Class.forName("net.sf.saxon.functions.ContextItemAccessorFunction"));
        sink(Class.forName("net.sf.saxon.functions.ContextItemAccessorFunction$StringAccessor"));
        sink(Class.forName("net.sf.saxon.functions.Count"));
        sink(Class.forName("net.sf.saxon.functions.Current"));
        sink(Class.forName("net.sf.saxon.functions.Empty"));
        sink(Class.forName("net.sf.saxon.functions.Exists"));
        sink(Class.forName("net.sf.saxon.functions.FunctionAvailable"));
        sink(Class.forName("net.sf.saxon.functions.KeyFn"));
        sink(Class.forName("net.sf.saxon.functions.LocalName_1"));
        sink(Class.forName("net.sf.saxon.functions.LowerCase"));
        sink(Class.forName("net.sf.saxon.functions.Matches"));
        sink(Class.forName("net.sf.saxon.functions.Name_1"));
        sink(Class.forName("net.sf.saxon.functions.NormalizeSpace_1"));
        sink(Class.forName("net.sf.saxon.functions.NotFn"));
        sink(Class.forName("net.sf.saxon.functions.Number_1"));
        sink(Class.forName("net.sf.saxon.functions.PositionAndLast$Last"));
        sink(Class.forName("net.sf.saxon.functions.PositionAndLast$Position"));
        sink(Class.forName("net.sf.saxon.functions.RegexFunctionSansFlags"));
        sink(Class.forName("net.sf.saxon.functions.Replace"));
        sink(Class.forName("net.sf.saxon.functions.ResolveURI"));
        sink(Class.forName("net.sf.saxon.functions.Reverse"));
        sink(Class.forName("net.sf.saxon.functions.StartsWith"));
        sink(Class.forName("net.sf.saxon.functions.StringJoin"));
        sink(Class.forName("net.sf.saxon.functions.StringLength_1"));
        sink(Class.forName("net.sf.saxon.functions.String_1"));
        sink(Class.forName("net.sf.saxon.functions.Substring"));
        sink(Class.forName("net.sf.saxon.functions.SubstringAfter"));
        sink(Class.forName("net.sf.saxon.functions.SubstringBefore"));
        sink(Class.forName("net.sf.saxon.functions.Tokenize_1"));
        sink(Class.forName("net.sf.saxon.functions.Tokenize_3"));
        sink(Class.forName("org.apache.xerces.impl.dv.dtd.DTDDVFactoryImpl"));
        sink(Class.forName("org.apache.xerces.jaxp.SAXParserFactoryImpl"));
        sink(Class.forName("org.apache.xerces.parsers.XIncludeAwareParserConfiguration"));
        sink(Class.forName("org.idpf.epubcheck.util.saxon.SaxonSchemaReaderFactory"));
        sink(Class.forName("org.w3c.dom.Document"));
        sink(Class.forName("org.xmlresolver.loaders.XmlLoader"));
        sink(Class.forName("javax.xml.parsers.FactoryFinder"));
        sink(Class.forName("javax.xml.transform.FactoryFinder"));
        sink(Class.forName("javax.xml.datatype.FactoryFinder"));
        sink(Class.forName("javax.xml.parsers.SAXParserFactory"));
        sink(Class.forName("javax.xml.parsers.DocumentBuilderFactory"));
        sink(Class.forName("javax.xml.transform.TransformerFactory"));
        sink(Class.forName("javax.xml.datatype.DatatypeFactory"));
        sink(Class.forName("com.adobe.epubcheck.reporting"));
    }
}
