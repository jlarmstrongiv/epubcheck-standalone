// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.io;

public class ObjectInputStream extends InputStream {
    public ObjectInputStream(InputStream in) throws IOException {
        throw new IOException("Java serialization is not supported in the TeaVM build");
    }

    protected ObjectInputStream() throws IOException {
        throw new IOException("Java serialization is not supported in the TeaVM build");
    }

    public final Object readObject() throws IOException, ClassNotFoundException {
        throw new IOException("Java serialization is not supported in the TeaVM build");
    }

    @Override
    public int read() throws IOException {
        throw new IOException("Java serialization is not supported in the TeaVM build");
    }

    public void defaultReadObject() throws IOException {
        throw new IOException("Java serialization is not supported in the TeaVM build");
    }
}
