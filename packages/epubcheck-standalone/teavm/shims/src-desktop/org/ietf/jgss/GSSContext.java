// TeaVM shim: existence stub for code paths epubcheck validation never executes.
package org.ietf.jgss;

public interface GSSContext {
    byte[] initSecContext(byte[] inputBuf, int offset, int len) throws GSSException;

    void requestMutualAuth(boolean state) throws GSSException;

    void requestCredDeleg(boolean state) throws GSSException;

    void dispose() throws GSSException;
}
