// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.net;

public abstract class ProxySelector {
    private static ProxySelector theDefault;

    public static ProxySelector getDefault() {
        return theDefault;
    }

    public static void setDefault(ProxySelector ps) {
        theDefault = ps;
    }

    public abstract java.util.List<Proxy> select(java.net.URI uri);

    public abstract void connectFailed(java.net.URI uri, SocketAddress sa, java.io.IOException ioe);
}
