package java.util.concurrent.atomic;

/** TeaVM shim: single-threaded VM, plain array semantics. See locks.Lock. */
public class AtomicReferenceArray<E> {
    private final Object[] array;

    public AtomicReferenceArray(int length) {
        array = new Object[length];
    }

    public AtomicReferenceArray(E[] initial) {
        array = new Object[initial.length];
        System.arraycopy(initial, 0, array, 0, initial.length);
    }

    public int length() {
        return array.length;
    }

    @SuppressWarnings("unchecked")
    public E get(int i) {
        return (E) array[i];
    }

    public void set(int i, E newValue) {
        array[i] = newValue;
    }

    public void lazySet(int i, E newValue) {
        array[i] = newValue;
    }

    @SuppressWarnings("unchecked")
    public E getAndSet(int i, E newValue) {
        Object old = array[i];
        array[i] = newValue;
        return (E) old;
    }

    public boolean compareAndSet(int i, E expect, E update) {
        if (array[i] == expect) {
            array[i] = update;
            return true;
        }
        return false;
    }

    public boolean weakCompareAndSet(int i, E expect, E update) {
        return compareAndSet(i, expect, update);
    }
}
