// TeaVM shim: existence stub for code paths epubcheck validation never executes.
package javax.security.auth.x500;

public final class X500Principal implements java.security.Principal {
    private final String name;

    public X500Principal(String name) {
        this.name = name;
    }

    @Override
    public String getName() {
        return name;
    }

    public String getName(String format) {
        return name;
    }
}
