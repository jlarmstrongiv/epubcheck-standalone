package ecshim;

import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.net.URLStreamHandlerFactory;

/**
 * Runtime installer for the "resource:" URL protocol that the forked
 * TClassLoader.getResource/getResources returns: opening such a URL streams
 * the embedded classpath resource. Must be called once by the wrapper before
 * epubcheck runs (Jing's service discovery opens these URLs).
 */
public final class ResourceUrlSetup {
    private static boolean installed;

    private ResourceUrlSetup() {
    }

    public static void install() {
        if (installed) {
            return;
        }
        installed = true;
        URL.setURLStreamHandlerFactory(new Factory());
    }

    static final class Factory implements URLStreamHandlerFactory {
        @Override
        public URLStreamHandler createURLStreamHandler(String protocol) {
            if ("resource".equals(protocol)) {
                return new ResourceHandler();
            }
            return null;
        }
    }

    static final class ResourceHandler extends URLStreamHandler {
        @Override
        protected URLConnection openConnection(URL u) {
            return new ResourceConnection(u);
        }
    }

    static final class ResourceConnection extends URLConnection {
        ResourceConnection(URL url) {
            super(url);
        }

        @Override
        public void connect() {
        }

        @Override
        public InputStream getInputStream() throws IOException {
            String path = url.getPath();
            if (path == null) {
                path = url.getFile();
            }
            if (path != null && path.startsWith("/")) {
                path = path.substring(1);
            }
            InputStream in = ClassLoader.getSystemClassLoader().getResourceAsStream(path);
            if (in == null) {
                throw new IOException("Embedded resource not found: " + path);
            }
            return in;
        }
    }
}
