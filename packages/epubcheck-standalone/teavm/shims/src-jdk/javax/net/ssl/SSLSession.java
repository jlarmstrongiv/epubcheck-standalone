// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package javax.net.ssl;

public interface SSLSession {
    String getProtocol();

    String getCipherSuite();

    java.security.Principal getPeerPrincipal() throws SSLPeerUnverifiedException;

    java.security.cert.Certificate[] getPeerCertificates() throws SSLPeerUnverifiedException;

    java.security.Principal getLocalPrincipal();
}
