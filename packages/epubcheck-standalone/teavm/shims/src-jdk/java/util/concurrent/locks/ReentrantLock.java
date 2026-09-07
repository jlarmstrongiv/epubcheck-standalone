package java.util.concurrent.locks;

import java.util.concurrent.TimeUnit;

/** TeaVM shim: single-threaded reentrant counter. See {@link Lock}. */
public class ReentrantLock implements Lock {
    private int holds;

    public ReentrantLock() {
    }

    public ReentrantLock(boolean fair) {
    }

    @Override
    public void lock() {
        holds++;
    }

    @Override
    public void lockInterruptibly() {
        holds++;
    }

    @Override
    public boolean tryLock() {
        holds++;
        return true;
    }

    @Override
    public boolean tryLock(long time, TimeUnit unit) {
        holds++;
        return true;
    }

    @Override
    public void unlock() {
        if (holds > 0) {
            holds--;
        }
    }

    @Override
    public Condition newCondition() {
        throw new UnsupportedOperationException("single-threaded shim: no conditions");
    }

    public boolean isLocked() {
        return holds > 0;
    }

    public boolean isHeldByCurrentThread() {
        return holds > 0;
    }

    public int getHoldCount() {
        return holds;
    }

    public boolean isFair() {
        return false;
    }
}
