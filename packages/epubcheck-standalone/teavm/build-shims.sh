#!/usr/bin/env bash
# Builds the TeaVM shim jar (build/shims/shims.jar) from the three source trees:
#   shims/src-jdk      java.* classes MISSING from TeaVM's classlib, compiled
#                      with --patch-module java.base so javac accepts the
#                      package names; TeaVM picks them up as plain classpath
#                      bytecode (classpath fallback for unsubstituted java.*).
#   shims/src-desktop  javax.imageio/java.beans stubs, compiled with
#                      --limit-modules java.base (their packages live in
#                      java.desktop, which this hides from javac).
#   shims/src-teavm    forks of TeaVM classlib T-classes (add missing methods;
#                      the shim jar precedes teavm-classlib on the compiler
#                      classpath so these forks win), the compiler plugin +
#                      extension policies, and target-side helpers (ecshim).
# Invoked by the Gradle buildShims task, which supplies JAVAC/JAR/SHIM_CP/OUT_DIR.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/shims"
OUT="${OUT_DIR:?OUT_DIR not set}"
JAVAC="${JAVAC:-javac}"
JAR="${JAR:-jar}"

rm -rf "$OUT/classes"
mkdir -p "$OUT/classes"

find "$SRC/src-jdk" -name '*.java' > "$OUT/jdk.list"
"$JAVAC" -proc:none -Xlint:-options --patch-module java.base="$SRC/src-jdk" \
  --add-reads java.base=ALL-UNNAMED -cp "${SHIM_CP:?SHIM_CP not set}" \
  -d "$OUT/classes" @"$OUT/jdk.list"

find "$SRC/src-desktop" -name '*.java' > "$OUT/desktop.list"
"$JAVAC" -proc:none -Xlint:-options --limit-modules java.base \
  -cp "$OUT/classes" -d "$OUT/classes" @"$OUT/desktop.list"

find "$SRC/src-teavm" -name '*.java' > "$OUT/tea.list"
"$JAVAC" -proc:none -Xlint:-options \
  -cp "$OUT/classes:${SHIM_CP:?SHIM_CP not set}" -d "$OUT/classes" @"$OUT/tea.list"

cp -R "$SRC/resources/." "$OUT/classes/"

"$JAR" cf "$OUT/shims.jar" -C "$OUT/classes" .
echo "built $OUT/shims.jar"
