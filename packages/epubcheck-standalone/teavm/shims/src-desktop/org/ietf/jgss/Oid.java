// TeaVM shim: existence stub for code paths epubcheck validation never executes
// (httpclient/Saxon cold paths). See java/util/concurrent/locks/Lock.java.
package org.ietf.jgss;

public class Oid {
    public Oid(String strOid) throws GSSException {
        throw new GSSException(0);
    }
}
