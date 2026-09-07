package java.util.concurrent.locks;

/** TeaVM shim: see {@link Lock}. */
public interface ReadWriteLock {
    Lock readLock();

    Lock writeLock();
}
