// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package javax.net.ssl;

public class SSLContext {
    public static SSLContext getDefault() throws java.security.NoSuchAlgorithmException {
        throw new java.security.NoSuchAlgorithmException("SSL is not supported in the TeaVM build");
    }

    public static SSLContext getInstance(String protocol) throws java.security.NoSuchAlgorithmException {
        throw new java.security.NoSuchAlgorithmException("SSL is not supported in the TeaVM build");
    }

    public final void init(KeyManager[] km, TrustManager[] tm, java.security.SecureRandom random)
            throws java.security.KeyManagementException {
        throw new UnsupportedOperationException("SSL is not supported in the TeaVM build");
    }

    public final SSLSocketFactory getSocketFactory() {
        throw new UnsupportedOperationException("SSL is not supported in the TeaVM build");
    }
}
