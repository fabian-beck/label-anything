#!/usr/bin/env bash
# The Java example of the design brief (§6.3), run verbatim in a scratch directory.
#   examples/brief/java/run.sh [path/to/label-anything-<version>.jar]
# The JAR bundles the native library (mvn -f bindings/java/pom.xml package); `java` must
# be Java 17+ (FFM on 22+, JNI below).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
JAR="$(realpath "${1:-$HERE/../../../bindings/java/target/label-anything-0.1.0.jar}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
java --enable-native-access=ALL-UNNAMED -cp "$JAR" "$HERE/Brief63.java"
