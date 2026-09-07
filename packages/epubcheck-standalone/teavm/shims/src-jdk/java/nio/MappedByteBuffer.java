package java.nio;

/**
 * TeaVM shim: type-existence stub for FileChannel.map's return type. No
 * instance is ever created (map() throws); it deliberately does NOT extend
 * ByteBuffer to avoid depending on JDK-version-specific package-private
 * constructors at shim-compile time.
 */
public abstract class MappedByteBuffer {
    MappedByteBuffer() {
    }
}
