// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package javax.crypto;

public class Cipher {
    public static Cipher getInstance(String transformation) throws java.security.NoSuchAlgorithmException {
        throw new java.security.NoSuchAlgorithmException("javax.crypto is not supported in the TeaVM build");
    }

    public void init(int opmode, java.security.Key key) throws java.security.InvalidKeyException {
        throw new UnsupportedOperationException("javax.crypto is not supported in the TeaVM build");
    }

    public byte[] doFinal(byte[] input) {
        throw new UnsupportedOperationException("javax.crypto is not supported in the TeaVM build");
    }
}
