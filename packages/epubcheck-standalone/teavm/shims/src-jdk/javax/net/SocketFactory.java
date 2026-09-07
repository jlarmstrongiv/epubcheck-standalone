// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package javax.net;

import java.io.IOException;
import java.net.Socket;

public abstract class SocketFactory {
    protected SocketFactory() {
    }

    public static SocketFactory getDefault() {
        throw new UnsupportedOperationException("Sockets are not supported in the TeaVM build");
    }

    public abstract Socket createSocket(String host, int port) throws IOException;

    public Socket createSocket() throws IOException {
        throw new IOException("Sockets are not supported in the TeaVM build");
    }
}
