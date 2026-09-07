package java.util.concurrent;

import java.util.AbstractQueue;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Iterator;
import java.util.Queue;

/** TeaVM shim: single-threaded VM, plain deque semantics. See locks.Lock. */
public class LinkedBlockingQueue<E> extends AbstractQueue<E> implements Queue<E> {
    private final ArrayDeque<E> deque = new ArrayDeque<>();
    private final int capacity;

    public LinkedBlockingQueue() {
        this.capacity = Integer.MAX_VALUE;
    }

    public LinkedBlockingQueue(int capacity) {
        this.capacity = capacity;
    }

    public LinkedBlockingQueue(Collection<? extends E> c) {
        this.capacity = Integer.MAX_VALUE;
        deque.addAll(c);
    }

    @Override
    public boolean offer(E e) {
        if (deque.size() >= capacity) {
            return false;
        }
        return deque.offer(e);
    }

    public void put(E e) {
        if (!offer(e)) {
            throw new IllegalStateException("queue full (single-threaded shim cannot block)");
        }
    }

    public E take() {
        E e = deque.poll();
        if (e == null) {
            throw new IllegalStateException("queue empty (single-threaded shim cannot block)");
        }
        return e;
    }

    public E poll(long timeout, TimeUnit unit) {
        return deque.poll();
    }

    @Override
    public E poll() {
        return deque.poll();
    }

    @Override
    public E peek() {
        return deque.peek();
    }

    @Override
    public Iterator<E> iterator() {
        return deque.iterator();
    }

    @Override
    public int size() {
        return deque.size();
    }

    public int remainingCapacity() {
        return capacity - deque.size();
    }

    public int drainTo(Collection<? super E> c) {
        int n = 0;
        E e;
        while ((e = deque.poll()) != null) {
            c.add(e);
            n++;
        }
        return n;
    }

    public int drainTo(Collection<? super E> c, int maxElements) {
        int n = 0;
        E e;
        while (n < maxElements && (e = deque.poll()) != null) {
            c.add(e);
            n++;
        }
        return n;
    }
}
