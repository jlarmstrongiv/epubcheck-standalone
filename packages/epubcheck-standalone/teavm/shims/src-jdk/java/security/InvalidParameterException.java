package java.security;

/** TeaVM shim: see java.util.concurrent.locks.Lock for the mechanism. */
public class InvalidParameterException extends IllegalArgumentException {
    public InvalidParameterException() {
    }

    public InvalidParameterException(String msg) {
        super(msg);
    }
}
