// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.util;

public class SimpleTimeZone extends TimeZone {
    private int rawOffset;

    public SimpleTimeZone(int rawOffset, String id) {
        this.rawOffset = rawOffset;
        setID(id);
    }

    @Override
    public int getOffset(int era, int year, int month, int day, int dayOfWeek, int milliseconds) {
        return rawOffset;
    }

    @Override
    public int getRawOffset() {
        return rawOffset;
    }

    @Override
    public void setRawOffset(int offsetMillis) {
        rawOffset = offsetMillis;
    }

    @Override
    public boolean inDaylightTime(Date date) {
        return false;
    }

    @Override
    public boolean useDaylightTime() {
        return false;
    }
}
