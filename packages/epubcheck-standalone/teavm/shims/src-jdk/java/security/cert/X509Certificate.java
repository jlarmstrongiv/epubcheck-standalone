// TeaVM shim: existence stub for code paths epubcheck validation never executes.
package java.security.cert;

public abstract class X509Certificate extends Certificate {
    protected X509Certificate() {
        super("X.509");
    }

    public abstract java.security.Principal getSubjectDN();

    public abstract java.security.Principal getIssuerDN();

    public javax.security.auth.x500.X500Principal getSubjectX500Principal() {
        return new javax.security.auth.x500.X500Principal("");
    }

    public javax.security.auth.x500.X500Principal getIssuerX500Principal() {
        return new javax.security.auth.x500.X500Principal("");
    }

    public java.util.Collection<java.util.List<?>> getSubjectAlternativeNames()
            throws CertificateParsingException {
        return null;
    }

    public java.util.Collection<java.util.List<?>> getIssuerAlternativeNames()
            throws CertificateParsingException {
        return null;
    }
}
