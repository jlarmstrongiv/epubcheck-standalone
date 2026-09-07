// TeaVM shim: existence stub for code paths epubcheck validation never executes.
package javax.net.ssl;

public interface HostnameVerifier {
    boolean verify(String hostname, SSLSession session);
}
