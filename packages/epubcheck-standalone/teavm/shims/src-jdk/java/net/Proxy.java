// TeaVM shim: existence stub for code paths epubcheck validation never executes.
package java.net;

public class Proxy {
    public enum Type {
        DIRECT,
        HTTP,
        SOCKS
    }

    public static final Proxy NO_PROXY = new Proxy();

    private Proxy() {
    }

    public Proxy(Type type, SocketAddress sa) {
    }

    public Type type() {
        return Type.DIRECT;
    }

    public SocketAddress address() {
        return null;
    }
}
