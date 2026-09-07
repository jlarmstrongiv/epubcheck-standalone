package java.util.concurrent.locks;

import java.util.concurrent.TimeUnit;

/** TeaVM shim: single-threaded; both sides are trivially grantable. See {@link Lock}. */
public class ReentrantReadWriteLock implements ReadWriteLock {
    private final ReadLock readLock = new ReadLock();
    private final WriteLock writeLock = new WriteLock();

    public ReentrantReadWriteLock() {
    }

    public ReentrantReadWriteLock(boolean fair) {
    }

    @Override
    public ReadLock readLock() {
        return readLock;
    }

    @Override
    public WriteLock writeLock() {
        return writeLock;
    }

    public int getReadLockCount() {
        return 0;
    }

    public boolean isWriteLocked() {
        return false;
    }

    public boolean isWriteLockedByCurrentThread() {
        return false;
    }

    public int getWriteHoldCount() {
        return 0;
    }

    public int getReadHoldCount() {
        return 0;
    }

    /** Trivially grantable single-threaded lock. */
    public static class ReadLock implements Lock {
        ReadLock() {
        }

        @Override
        public void lock() {
        }

        @Override
        public void lockInterruptibly() {
        }

        @Override
        public boolean tryLock() {
            return true;
        }

        @Override
        public boolean tryLock(long time, TimeUnit unit) {
            return true;
        }

        @Override
        public void unlock() {
        }

        @Override
        public Condition newCondition() {
            throw new UnsupportedOperationException("single-threaded shim: no conditions");
        }
    }

    /** Trivially grantable single-threaded lock. */
    public static class WriteLock implements Lock {
        WriteLock() {
        }

        @Override
        public void lock() {
        }

        @Override
        public void lockInterruptibly() {
        }

        @Override
        public boolean tryLock() {
            return true;
        }

        @Override
        public boolean tryLock(long time, TimeUnit unit) {
            return true;
        }

        @Override
        public void unlock() {
        }

        @Override
        public Condition newCondition() {
            throw new UnsupportedOperationException("single-threaded shim: no conditions");
        }
    }
}
