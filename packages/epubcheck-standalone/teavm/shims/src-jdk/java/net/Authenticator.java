// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.net;

public abstract class Authenticator {
    public enum RequestorType {
        PROXY,
        SERVER
    }

    private static Authenticator theAuthenticator;

    public static void setDefault(Authenticator a) {
        theAuthenticator = a;
    }

    protected PasswordAuthentication getPasswordAuthentication() {
        return null;
    }

    public static PasswordAuthentication requestPasswordAuthentication(String host, InetAddress addr,
            int port, String protocol, String prompt, String scheme, URL url, RequestorType reqType) {
        return null;
    }
}
