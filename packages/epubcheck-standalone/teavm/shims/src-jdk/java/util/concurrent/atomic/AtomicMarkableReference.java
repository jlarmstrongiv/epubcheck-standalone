// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.util.concurrent.atomic;

public class AtomicMarkableReference<V> {
    private V reference;
    private boolean mark;

    public AtomicMarkableReference(V initialRef, boolean initialMark) {
        reference = initialRef;
        mark = initialMark;
    }

    public V getReference() {
        return reference;
    }

    public boolean isMarked() {
        return mark;
    }

    public V get(boolean[] markHolder) {
        markHolder[0] = mark;
        return reference;
    }

    public boolean compareAndSet(V expectedReference, V newReference, boolean expectedMark, boolean newMark) {
        if (reference == expectedReference && mark == expectedMark) {
            reference = newReference;
            mark = newMark;
            return true;
        }
        return false;
    }

    public void set(V newReference, boolean newMark) {
        reference = newReference;
        mark = newMark;
    }

    public boolean attemptMark(V expectedReference, boolean newMark) {
        if (reference == expectedReference) {
            mark = newMark;
            return true;
        }
        return false;
    }
}
