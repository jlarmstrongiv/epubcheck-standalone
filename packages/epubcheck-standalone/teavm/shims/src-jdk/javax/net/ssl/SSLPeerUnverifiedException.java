// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package javax.net.ssl;

import java.io.IOException;

public class SSLPeerUnverifiedException extends IOException {
    public SSLPeerUnverifiedException(String reason) {
        super(reason);
    }
}
