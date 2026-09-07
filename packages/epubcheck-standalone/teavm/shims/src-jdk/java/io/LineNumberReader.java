// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.io;

public class LineNumberReader extends BufferedReader {
    private int lineNumber;

    public LineNumberReader(Reader in) {
        super(in);
    }

    public LineNumberReader(Reader in, int sz) {
        super(in, sz);
    }

    public int getLineNumber() {
        return lineNumber;
    }

    public void setLineNumber(int lineNumber) {
        this.lineNumber = lineNumber;
    }

    @Override
    public int read() throws IOException {
        int c = super.read();
        if (c == '\n') {
            lineNumber++;
        }
        return c;
    }

    @Override
    public String readLine() throws IOException {
        String line = super.readLine();
        if (line != null) {
            lineNumber++;
        }
        return line;
    }
}
