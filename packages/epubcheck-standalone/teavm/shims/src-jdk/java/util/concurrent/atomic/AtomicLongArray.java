package java.util.concurrent.atomic;

/** TeaVM shim: single-threaded VM, plain array semantics. See locks.Lock. */
public class AtomicLongArray {
    private final long[] array;

    public AtomicLongArray(int length) {
        array = new long[length];
    }

    public AtomicLongArray(long[] initial) {
        array = initial.clone();
    }

    public int length() {
        return array.length;
    }

    public long get(int i) {
        return array[i];
    }

    public void set(int i, long newValue) {
        array[i] = newValue;
    }

    public void lazySet(int i, long newValue) {
        array[i] = newValue;
    }

    public long getAndSet(int i, long newValue) {
        long old = array[i];
        array[i] = newValue;
        return old;
    }

    public boolean compareAndSet(int i, long expect, long update) {
        if (array[i] == expect) {
            array[i] = update;
            return true;
        }
        return false;
    }

    public long getAndIncrement(int i) {
        return array[i]++;
    }

    public long getAndDecrement(int i) {
        return array[i]--;
    }

    public long getAndAdd(int i, long delta) {
        long old = array[i];
        array[i] += delta;
        return old;
    }

    public long incrementAndGet(int i) {
        return ++array[i];
    }

    public long decrementAndGet(int i) {
        return --array[i];
    }

    public long addAndGet(int i, long delta) {
        array[i] += delta;
        return array[i];
    }
}
