// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package org.ietf.jgss;

public class GSSException extends Exception {
    public GSSException(int majorCode) {
        super("GSS error " + majorCode);
    }

    public int getMajor() {
        return 0;
    }

    public int getMinor() {
        return 0;
    }
}
