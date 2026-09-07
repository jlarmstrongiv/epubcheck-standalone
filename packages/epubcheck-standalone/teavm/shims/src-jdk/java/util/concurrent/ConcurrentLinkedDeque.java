// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.util.concurrent;

import java.util.AbstractCollection;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Iterator;

public class ConcurrentLinkedDeque<E> extends AbstractCollection<E> {
    private final ArrayDeque<E> deque = new ArrayDeque<>();

    public ConcurrentLinkedDeque() {
    }

    public ConcurrentLinkedDeque(Collection<? extends E> c) {
        deque.addAll(c);
    }

    @Override
    public boolean add(E e) {
        return deque.add(e);
    }

    public void addFirst(E e) {
        deque.addFirst(e);
    }

    public void addLast(E e) {
        deque.addLast(e);
    }

    public E poll() {
        return deque.poll();
    }

    public E pollFirst() {
        return deque.pollFirst();
    }

    public E pollLast() {
        return deque.pollLast();
    }

    public E peek() {
        return deque.peek();
    }

    public E peekFirst() {
        return deque.peekFirst();
    }

    public E peekLast() {
        return deque.peekLast();
    }

    @Override
    public Iterator<E> iterator() {
        return deque.iterator();
    }

    @Override
    public int size() {
        return deque.size();
    }
}
