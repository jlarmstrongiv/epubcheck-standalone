// TeaVM shim: existence stub for code paths epubcheck validation never executes.
package org.ietf.jgss;

public interface GSSName {
    Oid NT_HOSTBASED_SERVICE = null;

    GSSName canonicalize(Oid mech) throws GSSException;
}
