package java.beans;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * TeaVM shim: annotation-existence stub (jackson's Java7SupportImpl probes for
 * it reflectively). Compiled with --limit-modules java.base so javac accepts
 * the java.beans package in the unnamed module.
 */
@Documented
@Target(ElementType.CONSTRUCTOR)
@Retention(RetentionPolicy.RUNTIME)
public @interface ConstructorProperties {
    String[] value();
}
