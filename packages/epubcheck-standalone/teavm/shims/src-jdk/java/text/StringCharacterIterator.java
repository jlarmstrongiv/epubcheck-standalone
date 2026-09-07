package java.text;

/**
 * TeaVM shim: full standard implementation (TeaVM's classlib has
 * CharacterIterator but not this concrete class). Supplied as classpath
 * bytecode; see java.util.concurrent.locks.Lock for the mechanism.
 */
public final class StringCharacterIterator implements CharacterIterator {
    private String text;
    private int begin;
    private int end;
    private int pos;

    public StringCharacterIterator(String text) {
        this(text, 0);
    }

    public StringCharacterIterator(String text, int pos) {
        this(text, 0, text.length(), pos);
    }

    public StringCharacterIterator(String text, int begin, int end, int pos) {
        if (text == null) {
            throw new NullPointerException();
        }
        this.text = text;
        if (begin < 0 || begin > end || end > text.length()) {
            throw new IllegalArgumentException("Invalid substring range");
        }
        if (pos < begin || pos > end) {
            throw new IllegalArgumentException("Invalid position");
        }
        this.begin = begin;
        this.end = end;
        this.pos = pos;
    }

    public void setText(String text) {
        if (text == null) {
            throw new NullPointerException();
        }
        this.text = text;
        this.begin = 0;
        this.end = text.length();
        this.pos = 0;
    }

    @Override
    public char first() {
        pos = begin;
        return current();
    }

    @Override
    public char last() {
        if (end != begin) {
            pos = end - 1;
        } else {
            pos = end;
        }
        return current();
    }

    @Override
    public char setIndex(int p) {
        if (p < begin || p > end) {
            throw new IllegalArgumentException("Invalid index");
        }
        pos = p;
        return current();
    }

    @Override
    public char current() {
        if (pos >= begin && pos < end) {
            return text.charAt(pos);
        }
        return DONE;
    }

    @Override
    public char next() {
        if (pos < end - 1) {
            pos++;
            return text.charAt(pos);
        }
        pos = end;
        return DONE;
    }

    @Override
    public char previous() {
        if (pos > begin) {
            pos--;
            return text.charAt(pos);
        }
        return DONE;
    }

    @Override
    public int getBeginIndex() {
        return begin;
    }

    @Override
    public int getEndIndex() {
        return end;
    }

    @Override
    public int getIndex() {
        return pos;
    }

    @Override
    public boolean equals(Object obj) {
        if (this == obj) {
            return true;
        }
        if (!(obj instanceof StringCharacterIterator)) {
            return false;
        }
        StringCharacterIterator that = (StringCharacterIterator) obj;
        return hashCode() == that.hashCode() && text.equals(that.text)
                && pos == that.pos && begin == that.begin && end == that.end;
    }

    @Override
    public int hashCode() {
        return text.hashCode() ^ pos ^ begin ^ end;
    }

    @Override
    public Object clone() {
        try {
            return super.clone();
        } catch (CloneNotSupportedException e) {
            throw new InternalError();
        }
    }
}
