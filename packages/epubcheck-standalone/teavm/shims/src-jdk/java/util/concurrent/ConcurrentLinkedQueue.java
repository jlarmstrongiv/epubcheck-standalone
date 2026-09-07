package java.util.concurrent;

import java.util.AbstractQueue;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Iterator;
import java.util.Queue;

/**
 * TeaVM shim: single-threaded VM, so a plain ArrayDeque provides the exact
 * observable semantics. Supplied as classpath bytecode; see locks.Lock.
 */
public class ConcurrentLinkedQueue<E> extends AbstractQueue<E> implements Queue<E> {
    private final ArrayDeque<E> deque = new ArrayDeque<>();

    public ConcurrentLinkedQueue() {
    }

    public ConcurrentLinkedQueue(Collection<? extends E> c) {
        deque.addAll(c);
    }

    @Override
    public boolean offer(E e) {
        return deque.offer(e);
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

    @Override
    public boolean isEmpty() {
        return deque.isEmpty();
    }

    @Override
    public boolean add(E e) {
        return deque.add(e);
    }
}
