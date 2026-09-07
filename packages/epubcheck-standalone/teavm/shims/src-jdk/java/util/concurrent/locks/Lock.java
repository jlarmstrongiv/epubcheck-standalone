package java.util.concurrent.locks;

import java.util.concurrent.TimeUnit;

/**
 * TeaVM shim: TeaVM's class library has no java.util.concurrent.locks (the VM
 * is single-threaded). This is the standard interface surface; implementations
 * below are trivially reentrant counters. Compiled with
 * {@code --patch-module java.base} and supplied to TeaVM as plain classpath
 * bytecode (TeaVM falls back to the classpath for java.* classes its classlib
 * does not substitute).
 */
public interface Lock {
    void lock();

    void lockInterruptibly() throws InterruptedException;

    boolean tryLock();

    boolean tryLock(long time, TimeUnit unit) throws InterruptedException;

    void unlock();

    Condition newCondition();
}
