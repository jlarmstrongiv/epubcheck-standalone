// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.security.cert;

public abstract class Certificate {
    private final String type;

    protected Certificate(String type) {
        this.type = type;
    }

    public final String getType() {
        return type;
    }

    public abstract byte[] getEncoded() throws java.security.GeneralSecurityException;
}
