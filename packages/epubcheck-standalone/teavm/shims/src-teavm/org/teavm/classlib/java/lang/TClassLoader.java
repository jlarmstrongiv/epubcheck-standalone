/*
 *  Copyright 2014 Alexey Andreev.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
package org.teavm.classlib.java.lang;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import org.teavm.backend.javascript.spi.InjectedBy;
import org.teavm.classlib.impl.Base64Impl;
import org.teavm.interop.NoSideEffects;
import org.teavm.jso.JSBody;
import org.teavm.jso.JSIndexer;
import org.teavm.jso.JSObject;

public abstract class TClassLoader extends TObject {
    private TClassLoader parent;
    private static TSystemClassLoader systemClassLoader = new TSystemClassLoader();
    private static ResourceContainer resources;

    protected TClassLoader() {
        this(null);
    }

    protected TClassLoader(TClassLoader parent) {
        this.parent = parent;
    }

    public TClassLoader getParent() {
        return parent;
    }

    public static TClassLoader getSystemClassLoader() {
        return systemClassLoader;
    }

    public InputStream getResourceAsStream(String name) {
        if (resources == null) {
            resources = supplyResources();
        }
        JSObject data = resources.getResource(name);
        String dataString = resourceToString(data);
        if (dataString == null) {
            return null;
        }
        byte[] bytes = new byte[dataString.length()];
        for (int i = 0; i < bytes.length; ++i) {
            bytes[i] = (byte) dataString.charAt(i);
        }
        return new ByteArrayInputStream(Base64Impl.decode(bytes));
    }

    public static InputStream getSystemResourceAsStream(String name) {
        return getSystemClassLoader().getResourceAsStream(name);
    }

    @JSBody(params = "resource", script = "return resource !== null && resource !== void 0 ? resource : null;")
    private static native String resourceToString(JSObject resource);

    @InjectedBy(ClassLoaderNativeGenerator.class)
    @NoSideEffects
    private static native ResourceContainer supplyResources();

    interface ResourceContainer extends JSObject {
        @JSIndexer
        JSObject getResource(String name);
    }

    // --- epubcheck-standalone TeaVM shim additions (fork of the stock classlib file) ---

    public Class<?> loadClass(String name) throws ClassNotFoundException {
        return Class.forName(name);
    }

    protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
        return Class.forName(name);
    }

    public java.net.URL getResource(String name) {
        InputStream probe = getResourceAsStream(name);
        if (probe == null) {
            return null;
        }
        try {
            probe.close();
        } catch (java.io.IOException e) {
            // in-memory stream: cannot happen
        }
        try {
            // "resource:" URLs are served by the handler factory installed by the
            // epubcheck-standalone wrapper (ecshim.ResourceUrlSetup) over the embedded
            // resource container.
            return new java.net.URL("resource:/" + name);
        } catch (java.net.MalformedURLException e) {
            return null;
        }
    }

    public java.util.Enumeration<java.net.URL> getResources(String name) {
        java.net.URL url = getResource(name);
        java.util.ArrayList<java.net.URL> list = new java.util.ArrayList<>();
        if (url != null) {
            list.add(url);
        }
        return java.util.Collections.enumeration(list);
    }

    public static java.net.URL getSystemResource(String name) {
        return getSystemClassLoader().getResource(name);
    }


    // --- epubcheck-standalone TeaVM shim additions (fork of the stock classlib file) ---

    public static java.util.Enumeration<java.net.URL> getSystemResources(String name) {
        return getSystemClassLoader().getResources(name);
    }

}
