package java.net;

/** TeaVM shim: type-existence stub, see InetAddress. */
public class InetSocketAddress extends SocketAddress {
    private final String hostName;
    private final int port;

    public InetSocketAddress(InetAddress addr, int port) {
        this(addr != null ? addr.getHostName() : "0.0.0.0", port);
    }

    public InetSocketAddress(String hostName, int port) {
        this.hostName = hostName;
        this.port = port;
    }

    public final String getHostName() {
        return hostName;
    }

    public final String getHostString() {
        return hostName;
    }

    public final int getPort() {
        return port;
    }

    public final InetAddress getAddress() {
        return new InetAddress(hostName);
    }

    @Override
    public String toString() {
        return hostName + ":" + port;
    }
}
