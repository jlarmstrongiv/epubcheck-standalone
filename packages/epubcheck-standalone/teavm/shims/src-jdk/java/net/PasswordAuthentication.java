// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package java.net;

public final class PasswordAuthentication {
    private final String userName;
    private final char[] password;

    public PasswordAuthentication(String userName, char[] password) {
        this.userName = userName;
        this.password = password.clone();
    }

    public String getUserName() {
        return userName;
    }

    public char[] getPassword() {
        return password.clone();
    }
}
