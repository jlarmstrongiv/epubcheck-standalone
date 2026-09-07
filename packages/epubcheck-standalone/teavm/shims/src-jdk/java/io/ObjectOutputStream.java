// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.io;

public class ObjectOutputStream extends OutputStream {
    public ObjectOutputStream(OutputStream out) throws IOException {
        throw new IOException("Java serialization is not supported in the TeaVM build");
    }

    protected ObjectOutputStream() throws IOException {
        throw new IOException("Java serialization is not supported in the TeaVM build");
    }

    public final void writeObject(Object obj) throws IOException {
        throw new IOException("Java serialization is not supported in the TeaVM build");
    }

    @Override
    public void write(int b) throws IOException {
        throw new IOException("Java serialization is not supported in the TeaVM build");
    }

    public void defaultWriteObject() throws IOException {
        throw new IOException("Java serialization is not supported in the TeaVM build");
    }
}
