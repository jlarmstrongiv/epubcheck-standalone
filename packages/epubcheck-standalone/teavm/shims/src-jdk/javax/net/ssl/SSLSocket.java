// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package javax.net.ssl;

import java.net.Socket;

public abstract class SSLSocket extends Socket {
    protected SSLSocket() {
    }

    public abstract String[] getEnabledProtocols();

    public abstract void setEnabledProtocols(String[] protocols);

    public abstract String[] getEnabledCipherSuites();

    public abstract void setEnabledCipherSuites(String[] suites);

    public abstract SSLSession getSession();

    public abstract void startHandshake() throws java.io.IOException;
}
