// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.util.concurrent;

public class TimeoutException extends Exception {
    public TimeoutException() {
    }

    public TimeoutException(String message) {
        super(message);
    }
}
