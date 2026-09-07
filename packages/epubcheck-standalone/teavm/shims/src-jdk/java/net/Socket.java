// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.net;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public class Socket implements java.io.Closeable {
    public Socket() {
    }

    public Socket(String host, int port) throws IOException {
        throw new IOException("Sockets are not supported in the TeaVM build");
    }

    public InputStream getInputStream() throws IOException {
        throw new IOException("Sockets are not supported in the TeaVM build");
    }

    public OutputStream getOutputStream() throws IOException {
        throw new IOException("Sockets are not supported in the TeaVM build");
    }

    public void connect(SocketAddress endpoint, int timeout) throws IOException {
        throw new IOException("Sockets are not supported in the TeaVM build");
    }

    public void connect(SocketAddress endpoint) throws IOException {
        throw new IOException("Sockets are not supported in the TeaVM build");
    }

    public SocketAddress getRemoteSocketAddress() {
        return null;
    }

    public SocketAddress getLocalSocketAddress() {
        return null;
    }

    public int getSoTimeout() {
        return 0;
    }

    public boolean isConnected() {
        return false;
    }

    public boolean isClosed() {
        return true;
    }

    public void setSoTimeout(int t) {
    }

    public void setTcpNoDelay(boolean b) {
    }

    public void setKeepAlive(boolean b) {
    }

    public void setSoLinger(boolean on, int linger) {
    }

    public void setReuseAddress(boolean b) {
    }

    public void setReceiveBufferSize(int n) {
    }

    public void setSendBufferSize(int n) {
    }

    public void bind(SocketAddress bindpoint) throws IOException {
        throw new IOException("Sockets are not supported in the TeaVM build");
    }

    public void shutdownInput() throws IOException {
    }

    public void shutdownOutput() throws IOException {
    }

    public InetAddress getInetAddress() {
        return null;
    }

    public int getPort() {
        return 0;
    }

    @Override
    public void close() throws IOException {
    }
}
