// Leichtgewichtige Analyse von Java-Quelltext für das Klassendiagramm.

/** Entfernt Kommentare sowie Inhalte von Strings/Zeichen (Länge bleibt bei Zeilenumbrüchen erhalten). */
export function stripSource(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
    } else if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Liefert { kind, extends, implements, uses } für eine Datei.
 * kind: 'class' | 'abstract' | 'interface' | 'enum'
 */
export function analyze(className, src, allNames) {
  const s = stripSource(src);
  const re = new RegExp('\\b(abstract\\s+)?(?:(?:public|final|static|strictfp|sealed|non-sealed)\\s+)*(abstract\\s+)?(class|interface|enum|record)\\s+' + className + '\\b([^{]*)\\{');
  const m = re.exec(s);
  const info = { kind: 'class', extends: [], implements: [], uses: [] };
  if (m) {
    const isAbstract = !!(m[1] || m[2]);
    info.kind = m[3] === 'interface' ? 'interface' : m[3] === 'enum' ? 'enum' : isAbstract ? 'abstract' : 'class';
    const head = m[4].replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '');
    const ext = /\bextends\s+([\w.,\s]+?)(?=\bimplements\b|\bpermits\b|$)/.exec(head);
    const imp = /\bimplements\s+([\w.,\s]+?)(?=\bpermits\b|$)/.exec(head);
    const names = (t) => t.split(',').map((x) => x.trim().split('.').pop()).filter(Boolean);
    if (ext) {
      if (info.kind === 'interface') info.implements.push(...names(ext[1]));
      else info.extends.push(...names(ext[1]));
    }
    if (imp) info.implements.push(...names(imp[1]));
  }
  const rel = new Set([...info.extends, ...info.implements]);
  const idents = new Set(s.match(/[A-Za-z_$][\w$]*/g) || []);
  for (const other of allNames) {
    if (other !== className && idents.has(other) && !rel.has(other)) info.uses.push(other);
  }
  return info;
}

/** Erste Zeile, in der die Klasse deklariert ist, wird für Fehlermeldungen nicht benötigt; Hilfsfunktion Umbenennen: */
export function renameInSource(src, oldName, newName) {
  const re = new RegExp('\\b' + oldName.replace(/[$]/g, '\\$') + '\\b', 'g');
  return src.replace(re, newName);
}

export function isValidClassName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !JAVA_KEYWORDS.has(name);
}

export const JAVA_KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum ' +
  'extends final finally float for goto if implements import instanceof int interface long native new package private protected public ' +
  'return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record').split(' '));

export function classTemplate(name, kind) {
  const doc = (what) => `/**\n * Beschreiben Sie hier ${what} ${name}.\n * \n * @author (Ihr Name) \n * @version (eine Versionsnummer oder ein Datum)\n */\n`;
  if (kind === 'interface') return `\n${doc('das Interface')}public interface ${name}\n{\n    /**\n     * Ein Beispiel einer Methodensignatur.\n     */\n    void beispielMethode();\n}\n`;
  if (kind === 'enum') return `\n${doc('die Enumeration')}public enum ${name}\n{\n    EINS, ZWEI, DREI;\n}\n`;
  const abs = kind === 'abstract' ? 'abstract ' : '';
  return `\n${doc('die Klasse')}public ${abs}class ${name}\n{\n    // Instanzvariablen - ersetzen Sie das folgende Beispiel mit Ihren Variablen\n    private int x;\n\n    /**\n     * Konstruktor für Objekte der Klasse ${name}\n     */\n    public ${name}()\n    {\n        // Instanzvariable initialisieren\n        x = 0;\n    }\n\n    /**\n     * Ein Beispiel einer Methode - ersetzen Sie diesen Kommentar mit Ihrem eigenen\n     *  \n     * @param  y   ein Beispielparameter für eine Methode\n     * @return     die Summe aus x und y\n     */\n    public int beispielMethode(int y)\n    {\n        // tragen Sie hier den Code ein\n        return x + y;\n    }\n}\n`;
}
