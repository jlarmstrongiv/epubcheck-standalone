// TeaVM shim: existence stub for code paths epubcheck validation never executes.
package org.ietf.jgss;

public abstract class GSSManager {
    public static GSSManager getInstance() {
        throw new UnsupportedOperationException("GSS is not supported in the TeaVM build");
    }

    public abstract GSSName createName(String nameStr, Oid nameType) throws GSSException;

    public abstract GSSContext createContext(GSSName peer, Oid mech, GSSCredential myCred, int lifetime)
            throws GSSException;
}
