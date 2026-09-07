package org.w3c.epubcheck.core;

import com.adobe.epubcheck.opf.ValidationContext;

/**
 * Same-package accessor for the protected {@code AbstractChecker.context} field.
 *
 * This class is declared in package org.w3c.epubcheck.core purely so it gets
 * package-level access to AbstractChecker's protected field; it ships on the
 * wrapper classpath (wrapper/classes) and epubcheck.jar itself stays
 * byte-unmodified. Used by the pure-Java image substitution
 * (wrapper/PureJavaImageSubstitution.java).
 */
public final class CheckerContextAccess {

  private CheckerContextAccess() {
  }

  public static ValidationContext contextOf(AbstractChecker checker) {
    return checker.context;
  }
}
