// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package javax.crypto.spec;

public class SecretKeySpec {
    public SecretKeySpec(byte[] key, String algorithm) {
        throw new UnsupportedOperationException("javax.crypto is not supported in the TeaVM build");
    }
}
