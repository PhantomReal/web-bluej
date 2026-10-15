#!/bin/sh
# Baut web/jars/bluejweb.jar (Java-8-kompatibel, damit es in CheerpJ läuft).
set -e
cd "$(dirname "$0")"
ECJ=../web/jars/ecj.jar
rm -rf build && mkdir -p build
javac --release 8 -Xlint:-options -cp "$ECJ" -d build $(find src -name '*.java')
jar cf ../web/jars/bluejweb.jar -C build .
echo "OK: web/jars/bluejweb.jar"
