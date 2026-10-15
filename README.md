# Web-BlueJ

Eine im Browser laufende Nachbildung der Bedienung von [BlueJ](https://bluej.org) – gedacht zum Lernen und Üben, besonders auf dem **iPad**. Kein Server nötig: Java wird direkt im Browser übersetzt und ausgeführt.

> Web-BlueJ ist ein eigenständiges Projekt und nicht mit BlueJ / King's College London verbunden.

## Funktionen

- **Klassendiagramm** mit verschiebbaren Klassen, Pfeilen für Vererbung, Interfaces und „benutzt“; nicht übersetzte Klassen sind schraffiert
- **Objekte erzeugen** per Rechtsklick / langem Drücken (`new Klasse(…)`), **Objekt-Bench**, Methodenaufruf mit Parameterdialog und Ergebnisanzeige
- **Inspektor** für Objekte, Arrays und statische Felder
- **Codepad** (Ausdrücke und Anweisungen, `Typ name = …;` legt ein Objekt auf die Bench)
- **Editor** (CodeMirror) mit Reitern, Fehlerzeilen, Strg+K = Übersetzen, Schriftgröße für Touch
- **Terminal** für `System.out`, `System.err` und `System.in`
- **Projekte** lokal im Browser gespeichert; **ZIP-Export/-Import im BlueJ-Format** (`package.bluej` mit Klassenpositionen) – Projekte lassen sich zwischen iPad und Desktop-BlueJ austauschen
- Standard-Klassenvorlage wie in BlueJ (deutsch)
- **Java-Lexikon** (if/else, Schleifen, Arrays, ArrayList, Klassen, Vererbung …) mit Beispielen, die sich im Codepad ausführen oder in den Editor einfügen lassen; im Editor erklärt „?“ das Wort am Cursor
- **Fenstergrößen** per Trennlinie änderbar (Editor, Terminal, Codepad, Bench); Doppeltippen setzt zurück
- Import per ZIP, Ordner, Drag & Drop oder eingefügtem Quelltext

Nicht enthalten: Debugger (Haltepunkte), JUnit-Tests, Pakete, Swing/JavaFX-Fenster.

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `web/` | die statische Web-App (wird so veröffentlicht) |
| `web/js/` | Oberfläche (Diagramm, Editor, Dialoge, Projektspeicher, ZIP) |
| `web/jars/bluejweb.jar` | Java-Brücke (kompiliert, Java-8-kompatibel) |
| `web/jars/ecj.jar` | Eclipse-Java-Compiler 3.26 (EPL-2.0) |
| `java/src/` | Quelltext der Java-Brücke `bluej.web.Bridge` |
| `java/dev/DevServer.java` | Entwicklungs-Server, um die Oberfläche ohne CheerpJ zu testen |

Technik: [CheerpJ](https://cheerpj.com) (JVM in WebAssembly, wird beim Start von `cjrtnc.leaningtech.com` geladen) führt die Java-Brücke aus; diese übersetzt mit dem Eclipse-Compiler im Speicher und steuert Objekte per Reflection.

## Lokal starten

```sh
python3 -m http.server 8080 -d web      # dann http://localhost:8080
```

CheerpJ braucht Internet (Laufzeit-Download) und `http(s)://` – `file://` funktioniert nicht.

### Ohne CheerpJ entwickeln

```sh
java -cp web/jars/bluejweb.jar:web/jars/ecj.jar java/dev/DevServer.java
# Seite mit ?dev=1 öffnen: http://localhost:8080/?dev=1
```

### Java-Brücke neu bauen

```sh
java/build.sh
```

## Veröffentlichen

Der Workflow `.github/workflows/pages.yml` veröffentlicht den Ordner `web/` über GitHub Pages (Einstellungen → Pages → Quelle: „GitHub Actions“). Danach auf dem iPad die Seite öffnen und über Teilen → „Zum Home-Bildschirm“ ablegen.

## Lizenzen

CodeMirror 5 (MIT) in `web/vendor/codemirror`, Eclipse Compiler for Java (EPL-2.0) in `web/jars/ecj.jar`.
