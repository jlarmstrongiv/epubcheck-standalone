// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.net;

import java.io.IOException;

public class UnknownHostException extends IOException {
    public UnknownHostException() {
    }

    public UnknownHostException(String message) {
        super(message);
    }
}
