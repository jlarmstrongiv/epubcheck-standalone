// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.io;

public class CharConversionException extends IOException {
    public CharConversionException() {
    }

    public CharConversionException(String s) {
        super(s);
    }
}
