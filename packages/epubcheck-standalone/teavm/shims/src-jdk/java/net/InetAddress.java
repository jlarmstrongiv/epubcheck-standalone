package java.net;

/**
 * TeaVM shim: type-existence stub (jackson-databind's serializer registry
 * references the type; no instance is ever created during validation).
 * See java.util.concurrent.locks.Lock for the mechanism.
 */
public class InetAddress {
    private final String hostName;

    InetAddress(String hostName) {
        this.hostName = hostName;
    }

    public static InetAddress getByName(String host) throws UnknownHostException {
        throw new UnknownHostException("name resolution is not supported in the TeaVM build");
    }

    public static InetAddress[] getAllByName(String host) throws UnknownHostException {
        throw new UnknownHostException("name resolution is not supported in the TeaVM build");
    }

    public String getHostAddress() {
        return hostName;
    }

    public String getHostName() {
        return hostName;
    }

    public String getCanonicalHostName() {
        return hostName;
    }

    @Override
    public String toString() {
        return hostName + "/" + hostName;
    }
}
