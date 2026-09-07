package com.thaiopensource.relaxng.pattern;

import java.util.ArrayDeque;

/**
 * epubcheck-standalone TeaVM shim: fork of Jing's ChoicePattern (jing-20181222) with
 * the chain-recursive walks rewritten iteratively. The jing jar itself is
 * untouched; this copy shadows it because shims.jar precedes the epubcheck
 * jars on the TeaVM compiler classpath.
 *
 * WHY: the epub RELAX NG schemas contain choice chains that reach ~2600
 * effective levels once ref indirection is followed (measured on
 * epub-package/xhtml schemas during war-and-peace validation). Jing's
 * recursive expand()/checkRestrictions() handle that fine on the JVM, but
 * under TeaVM's JS backend both methods are CPS-lowered (async because the
 * datatype-library path is), which makes their JS stack frames several times
 * fatter than JVM frames. The recursion then needs >500KB of JS stack:
 * fine in Node (default --stack-size=984) and on Chrome's main thread, but
 * it OVERFLOWS inside a Chrome Web Worker on macOS (~512KB thread stack) --
 * "RangeError: Maximum call stack size exceeded" -> epubcheck exit 1.
 * Measured frame census at the overflow: 6712 frames, of which 2609
 * ChoicePattern.expand + 2797 BinaryPattern dispatch stubs.
 *
 * The iterative rewrites below preserve the original evaluation order and
 * side-effect sequence exactly (left child first; startChoice/alternative/
 * endChoice bracketing; makeChoice called with the same arguments in the
 * same cases). Non-choice children still expand via ordinary virtual calls,
 * so each ref/element/interleave hop costs only constant extra frames.
 */
class ChoicePattern extends BinaryPattern {
  ChoicePattern(Pattern p1, Pattern p2) {
    super(p1.isNullable() || p2.isNullable(),
        combineHashCode(CHOICE_HASH_CODE, p1.hashCode(), p2.hashCode()), p1, p2);
  }

  @Override
  Pattern expand(SchemaPatternBuilder b) {
    // Explicit-stack post-order simulation of:
    //   ep1 = p1.expand(b); ep2 = p2.expand(b);
    //   return (ep1 != p1 || ep2 != p2) ? b.makeChoice(ep1, ep2) : this;
    // Frame layout: { node, ep1-or-null, ep2-or-null }.
    ArrayDeque<Object[]> st = new ArrayDeque<>();
    st.push(new Object[] { this, null, null });
    Pattern ret = null;
    while (!st.isEmpty()) {
      Object[] fr = st.peek();
      ChoicePattern node = (ChoicePattern) fr[0];
      if (fr[1] == null) {
        if (ret != null) {
          fr[1] = ret;
          ret = null;
        } else if (node.p1 instanceof ChoicePattern) {
          st.push(new Object[] { node.p1, null, null });
        } else {
          fr[1] = node.p1.expand(b);
        }
        continue;
      }
      if (fr[2] == null) {
        if (ret != null) {
          fr[2] = ret;
          ret = null;
        } else if (node.p2 instanceof ChoicePattern) {
          st.push(new Object[] { node.p2, null, null });
        } else {
          fr[2] = node.p2.expand(b);
        }
        continue;
      }
      st.pop();
      Pattern ep1 = (Pattern) fr[1];
      Pattern ep2 = (Pattern) fr[2];
      ret = ep1 != node.p1 || ep2 != node.p2 ? b.makeChoice(ep1, ep2) : node;
    }
    return ret;
  }

  @Override
  boolean containsChoice(Pattern p) {
    // Original: return p1.containsChoice(p) || p2.containsChoice(p);
    // Left-to-right DFS with short-circuit, choice nodes descend only.
    ArrayDeque<Pattern> work = new ArrayDeque<>();
    work.push(p2);
    work.push(p1);
    while (!work.isEmpty()) {
      Pattern cur = work.pop();
      if (cur instanceof ChoicePattern) {
        ChoicePattern c = (ChoicePattern) cur;
        work.push(c.p2);
        work.push(c.p1);
      } else if (cur.containsChoice(p)) {
        return true;
      }
    }
    return false;
  }

  @Override
  <T> T apply(PatternFunction<T> f) {
    return f.caseChoice(this);
  }

  @Override
  void checkRestrictions(int context, DuplicateAttributeDetector dad, Alphabet alpha)
      throws RestrictionViolationException {
    // Explicit-stack simulation of:
    //   if (dad != null) dad.startChoice();
    //   p1.checkRestrictions(context, dad, alpha);
    //   if (dad != null) dad.alternative();
    //   p2.checkRestrictions(context, dad, alpha);
    //   if (dad != null) dad.endChoice();
    // Frame layout: { node, state } with state 0 -> before p1, 1 -> before p2,
    // 2 -> after p2. Exceptions propagate out abandoning the deque, exactly
    // like recursive unwinding.
    ArrayDeque<Object[]> st = new ArrayDeque<>();
    st.push(new Object[] { this, 0 });
    while (!st.isEmpty()) {
      Object[] fr = st.peek();
      ChoicePattern node = (ChoicePattern) fr[0];
      int state = (Integer) fr[1];
      if (state == 0) {
        if (dad != null) {
          dad.startChoice();
        }
        fr[1] = 1;
        if (node.p1 instanceof ChoicePattern) {
          st.push(new Object[] { node.p1, 0 });
        } else {
          node.p1.checkRestrictions(context, dad, alpha);
        }
      } else if (state == 1) {
        if (dad != null) {
          dad.alternative();
        }
        fr[1] = 2;
        if (node.p2 instanceof ChoicePattern) {
          st.push(new Object[] { node.p2, 0 });
        } else {
          node.p2.checkRestrictions(context, dad, alpha);
        }
      } else {
        if (dad != null) {
          dad.endChoice();
        }
        st.pop();
      }
    }
  }
}
