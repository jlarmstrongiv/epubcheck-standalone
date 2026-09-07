// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package javax.net.ssl;

import javax.net.SocketFactory;

public abstract class SSLSocketFactory extends SocketFactory {
    protected SSLSocketFactory() {
    }

    public static SocketFactory getDefault() {
        throw new UnsupportedOperationException("SSL is not supported in the TeaVM build");
    }

    public abstract java.net.Socket createSocket(java.net.Socket s, String host, int port, boolean autoClose)
            throws java.io.IOException;
}
