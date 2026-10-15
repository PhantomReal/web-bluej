package bluej.web;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Array;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.eclipse.jdt.internal.compiler.ClassFile;
import org.eclipse.jdt.internal.compiler.CompilationResult;
import org.eclipse.jdt.internal.compiler.Compiler;
import org.eclipse.jdt.internal.compiler.DefaultErrorHandlingPolicies;
import org.eclipse.jdt.internal.compiler.ICompilerRequestor;
import org.eclipse.jdt.internal.compiler.classfmt.ClassFileReader;
import org.eclipse.jdt.internal.compiler.env.ICompilationUnit;
import org.eclipse.jdt.internal.compiler.env.INameEnvironment;
import org.eclipse.jdt.internal.compiler.env.NameEnvironmentAnswer;
import org.eclipse.jdt.internal.compiler.impl.CompilerOptions;
import org.eclipse.jdt.internal.compiler.problem.DefaultProblemFactory;
import org.eclipse.jdt.core.compiler.CategorizedProblem;

/**
 * Brücke zwischen der Web-Oberfläche (JavaScript) und der Java-Laufzeit.
 * Alle öffentlichen Methoden sind statisch und nutzen nur Strings, damit sie
 * einfach aus CheerpJ aufgerufen werden können. Rückgabewerte sind JSON.
 */
public final class Bridge {
    private Bridge() {}

    // ------------------------------------------------------------------ Zustand

    private static String level = "1.8";
    private static MemLoader loader = new MemLoader();
    private static final Map<String, byte[]> classBytes = new HashMap<String, byte[]>();
    private static final Map<String, Object> bench = new LinkedHashMap<String, Object>();
    private static final Map<String, String> benchTypes = new HashMap<String, String>();
    private static final Map<String, Object> temps = new HashMap<String, Object>();
    private static int tempCounter = 0;
    private static int evalCounter = 0;

    private static final Terminal terminal = new Terminal();
    private static final QueueInputStream stdin = new QueueInputStream();

    static {
        System.setOut(new PrintStream(new TermStream(0), true));
        System.setErr(new PrintStream(new TermStream(1), true));
        System.setIn(stdin);
    }

    public static String version() {
        return "bluej-web-bridge 1 / java " + System.getProperty("java.version");
    }

    /** Sprachstufe für den Compiler, z. B. "1.8" oder "16". */
    public static String setLevel(String lvl) {
        level = lvl;
        return "ok";
    }

    // ------------------------------------------------------------ Terminal / Eingabe

    private static final class Terminal {
        final StringBuilder sb = new StringBuilder();
        int last = -1;

        synchronized void append(int stream, String s) {
            if (s.isEmpty()) return;
            if (stream != last) {
                sb.append(stream == 0 ? '\u0001' : '\u0002');
                last = stream;
            }
            sb.append(s);
        }

        synchronized String drain() {
            String s = sb.toString();
            sb.setLength(0);
            last = -1;
            return s;
        }
    }

    private static final class TermStream extends OutputStream {
        private final int stream;
        TermStream(int stream) { this.stream = stream; }
        @Override public void write(int b) { write(new byte[] { (byte) b }, 0, 1); }
        @Override public void write(byte[] b, int off, int len) {
            terminal.append(stream, new String(b, off, len, StandardCharsets.UTF_8));
        }
    }

    private static final class QueueInputStream extends InputStream {
        private final LinkedBlockingQueue<Integer> q = new LinkedBlockingQueue<Integer>();
        @Override public int read() {
            try {
                return q.take();
            } catch (InterruptedException e) {
                return -1;
            }
        }
        @Override public int read(byte[] b, int off, int len) {
            if (len == 0) return 0;
            int first = read();
            if (first < 0) return -1;
            b[off] = (byte) first;
            int n = 1;
            while (n < len) {
                Integer next = q.poll();
                if (next == null) break;
                b[off + n++] = (byte) (int) next;
            }
            return n;
        }
        @Override public int available() { return q.size(); }
        void feed(String s) {
            for (byte x : s.getBytes(StandardCharsets.UTF_8)) q.add(x & 0xff);
        }
    }

    /** Liefert die seit dem letzten Aufruf angefallene Ausgabe (\u0001 = stdout, \u0002 = stderr). */
    public static String drain() { return terminal.drain(); }

    public static String feedInput(String line) {
        stdin.feed(line);
        return "ok";
    }

    // ------------------------------------------------------------------ Compiler

    private static final class MemLoader extends ClassLoader {
        MemLoader() { super(Bridge.class.getClassLoader()); }
        @Override protected Class<?> findClass(String name) throws ClassNotFoundException {
            byte[] b = classBytes.get(name);
            if (b == null) throw new ClassNotFoundException(name);
            return defineClass(name, b, 0, b.length);
        }
    }

    private static final class Unit implements ICompilationUnit {
        final String file;
        final char[] src;
        Unit(String file, String src) { this.file = file; this.src = src.toCharArray(); }
        @Override public char[] getContents() { return src; }
        @Override public char[] getMainTypeName() {
            String n = file.substring(0, file.length() - 5);
            return n.toCharArray();
        }
        @Override public char[][] getPackageName() { return null; }
        @Override public char[] getFileName() { return file.toCharArray(); }
        @Override public boolean ignoreOptionalProblems() { return false; }
    }

    private static final String[] PACKAGE_ROOTS = { "java", "javax", "jdk", "org", "com", "sun" };

    private static class LibEnv implements INameEnvironment {
        private final Set<String> sourceTypes;
        LibEnv(Set<String> sourceTypes) { this.sourceTypes = sourceTypes; }

        private NameEnvironmentAnswer find(String dotted) {
            if (sourceTypes.contains(dotted)) return null;
            String res = dotted.replace('.', '/') + ".class";
            InputStream in = null;
            try {
                in = ClassLoader.getSystemResourceAsStream(res);
                if (in == null) in = Bridge.class.getClassLoader().getResourceAsStream(res);
                if (in == null) return null;
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                ClassFileReader r = new ClassFileReader(bo.toByteArray(), res.toCharArray(), true);
                return new NameEnvironmentAnswer(r, null);
            } catch (Exception e) {
                return null;
            } finally {
                try { if (in != null) in.close(); } catch (Exception ignore) {}
            }
        }

        static String join(char[][] parts) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < parts.length; i++) {
                if (i > 0) sb.append('.');
                sb.append(parts[i]);
            }
            return sb.toString();
        }

        @Override public NameEnvironmentAnswer findType(char[][] compoundTypeName) {
            return find(join(compoundTypeName));
        }

        @Override public NameEnvironmentAnswer findType(char[] typeName, char[][] packageName) {
            String p = packageName == null || packageName.length == 0 ? "" : join(packageName) + ".";
            return find(p + new String(typeName));
        }

        @Override public boolean isPackage(char[][] parentPackageName, char[] packageName) {
            String name = new String(packageName);
            if (parentPackageName == null || parentPackageName.length == 0) {
                for (String r : PACKAGE_ROOTS) if (r.equals(name)) return true;
                return false;
            }
            String full = join(parentPackageName) + "." + name;
            if (find(full) != null) return false;
            String root = new String(parentPackageName[0]);
            for (String r : PACKAGE_ROOTS) if (r.equals(root)) return Character.isLowerCase(name.charAt(0));
            return false;
        }

        @Override public void cleanup() {}
    }

    private static CompilerOptions options() {
        Map<String, String> o = new HashMap<String, String>();
        o.put(CompilerOptions.OPTION_Source, level);
        o.put(CompilerOptions.OPTION_Compliance, level);
        o.put(CompilerOptions.OPTION_TargetPlatform, level);
        o.put(CompilerOptions.OPTION_LineNumberAttribute, CompilerOptions.GENERATE);
        o.put(CompilerOptions.OPTION_SourceFileAttribute, CompilerOptions.GENERATE);
        o.put(CompilerOptions.OPTION_LocalVariableAttribute, CompilerOptions.GENERATE);
        o.put(CompilerOptions.OPTION_MethodParametersAttribute, CompilerOptions.GENERATE);
        o.put(CompilerOptions.OPTION_ReportUnusedLocal, CompilerOptions.IGNORE);
        o.put(CompilerOptions.OPTION_ReportDeprecation, CompilerOptions.IGNORE);
        o.put(CompilerOptions.OPTION_ReportRawTypeReference, CompilerOptions.IGNORE);
        o.put(CompilerOptions.OPTION_ReportUncheckedTypeOperation, CompilerOptions.IGNORE);
        o.put(CompilerOptions.OPTION_ReportUnnecessaryTypeCheck, CompilerOptions.IGNORE);
        o.put(CompilerOptions.OPTION_ReportMissingSerialVersion, CompilerOptions.IGNORE);
        o.put(CompilerOptions.OPTION_ReportHiddenCatchBlock, CompilerOptions.IGNORE);
        o.put(CompilerOptions.OPTION_ReportUnusedPrivateMember, CompilerOptions.IGNORE);
        o.put(CompilerOptions.OPTION_ReportUnusedImport, CompilerOptions.IGNORE);
        o.put(CompilerOptions.OPTION_ReportFieldHiding, CompilerOptions.IGNORE);
        o.put(CompilerOptions.OPTION_ReportLocalVariableHiding, CompilerOptions.IGNORE);
        return new CompilerOptions(o);
    }

    private static final class Outcome {
        final List<String> problemsJson = new ArrayList<String>();
        final Set<String> failedFiles = new HashSet<String>();
        final Map<String, byte[]> classes = new LinkedHashMap<String, byte[]>();
        final Map<String, String> classFile = new HashMap<String, String>();
        int errorCount = 0;
        String firstError = null;
    }

    private static Outcome runCompiler(Map<String, String> files) {
        final Outcome out = new Outcome();
        List<ICompilationUnit> units = new ArrayList<ICompilationUnit>();
        Set<String> names = new HashSet<String>();
        for (Map.Entry<String, String> e : files.entrySet()) {
            units.add(new Unit(e.getKey(), e.getValue()));
            names.add(e.getKey().substring(0, e.getKey().length() - 5));
        }
        ICompilerRequestor requestor = new ICompilerRequestor() {
            @Override public void acceptResult(CompilationResult result) {
                String file = new String(result.getCompilationUnit().getFileName());
                CategorizedProblem[] probs = result.getProblems();
                boolean hasError = false;
                if (probs != null) {
                    for (CategorizedProblem p : probs) {
                        boolean err = p.isError();
                        if (err) {
                            hasError = true;
                            out.errorCount++;
                        }
                        if (p.isError() || p.isWarning()) {
                            out.problemsJson.add("{\"file\":" + q(file) + ",\"line\":" + p.getSourceLineNumber()
                                + ",\"start\":" + p.getSourceStart() + ",\"end\":" + p.getSourceEnd()
                                + ",\"error\":" + err + ",\"message\":" + q(p.getMessage()) + "}");
                            if (err && out.firstError == null) out.firstError = p.getMessage();
                        }
                    }
                }
                if (hasError) {
                    out.failedFiles.add(file);
                } else {
                    for (ClassFile cf : result.getClassFiles()) {
                        String cn = new String(cf.fileName()).replace('/', '.');
                        out.classes.put(cn, cf.getBytes());
                        out.classFile.put(cn, file);
                    }
                }
            }
        };
        Compiler compiler = new Compiler(new LibEnv(names),
            DefaultErrorHandlingPolicies.proceedWithAllProblems(), options(), requestor,
            new DefaultProblemFactory(Locale.GERMAN));
        compiler.compile(units.toArray(new ICompilationUnit[0]));
        return out;
    }

    /**
     * Übersetzt alle Dateien. Eingabe: Dateiname \u0000 Inhalt \u0001 Dateiname \u0000 Inhalt ...
     * Ausgabe: {"ok":bool,"problems":[...],"classes":{"Name":"Datei.java"},"failed":["Datei.java"]}
     */
    public static String compile(String payload) {
        try {
            Map<String, String> files = new LinkedHashMap<String, String>();
            for (String part : payload.split("\u0001")) {
                if (part.isEmpty()) continue;
                int i = part.indexOf('\u0000');
                files.put(part.substring(0, i), part.substring(i + 1));
            }
            Outcome o = runCompiler(files);
            classBytes.clear();
            classBytes.putAll(o.classes);
            loader = new MemLoader();
            bench.clear();
            benchTypes.clear();
            temps.clear();
            StringBuilder sb = new StringBuilder("{\"ok\":").append(o.errorCount == 0).append(",\"problems\":[");
            for (int i = 0; i < o.problemsJson.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append(o.problemsJson.get(i));
            }
            sb.append("],\"classes\":{");
            boolean first = true;
            for (Map.Entry<String, String> e : o.classFile.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(q(e.getKey())).append(':').append(q(e.getValue()));
            }
            sb.append("},\"failed\":[");
            first = true;
            for (String f : o.failedFiles) {
                if (!first) sb.append(',');
                first = false;
                sb.append(q(f));
            }
            return sb.append("]}").toString();
        } catch (Throwable t) {
            return "{\"ok\":false,\"internal\":" + q(trace(t)) + ",\"problems\":[],\"classes\":{},\"failed\":[]}";
        }
    }

    // -------------------------------------------------------------------- Hilfen

    static String q(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    private static String trace(Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        return sw.toString();
    }

    /** Parst ein JSON-Array aus Strings. */
    static List<String> parseStringArray(String json) {
        List<String> out = new ArrayList<String>();
        int i = json.indexOf('[') + 1;
        int n = json.length();
        while (i < n) {
            char c = json.charAt(i);
            if (c == '"') {
                StringBuilder sb = new StringBuilder();
                i++;
                while (i < n && json.charAt(i) != '"') {
                    char d = json.charAt(i);
                    if (d == '\\') {
                        char e = json.charAt(++i);
                        switch (e) {
                            case 'n': sb.append('\n'); break;
                            case 'r': sb.append('\r'); break;
                            case 't': sb.append('\t'); break;
                            case 'b': sb.append('\b'); break;
                            case 'f': sb.append('\f'); break;
                            case 'u': sb.append((char) Integer.parseInt(json.substring(i + 1, i + 5), 16)); i += 4; break;
                            default: sb.append(e);
                        }
                    } else {
                        sb.append(d);
                    }
                    i++;
                }
                out.add(sb.toString());
            } else if (c == ']') {
                break;
            }
            i++;
        }
        return out;
    }

    private static String typeName(Class<?> c) {
        return c.getSimpleName().isEmpty() ? c.getName() : c.getSimpleName();
    }

    private static String sourceName(Class<?> c) {
        if (c.isArray()) return sourceName(c.getComponentType()) + "[]";
        return c.getName().replace('$', '.');
    }

    private static Class<?> findClass(String name) throws ClassNotFoundException {
        return Class.forName(name, true, loader);
    }

    // ------------------------------------------------------------- Klassen-Info

    private static String paramsJson(Class<?>[] types, java.lang.reflect.Parameter[] ps) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < types.length; i++) {
            if (i > 0) sb.append(',');
            String nm = ps != null && i < ps.length ? ps[i].getName() : "arg" + i;
            sb.append("{\"type\":").append(q(typeName(types[i]))).append(",\"name\":").append(q(nm)).append('}');
        }
        return sb.append(']').toString();
    }

    private static String key(String name, Class<?>[] types) {
        StringBuilder sb = new StringBuilder(name).append('(');
        for (int i = 0; i < types.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(types[i].getName());
        }
        return sb.append(')').toString();
    }

    public static String classInfo(String className) {
        try {
            Class<?> c = findClass(className);
            StringBuilder sb = new StringBuilder("{\"name\":").append(q(className));
            sb.append(",\"interface\":").append(c.isInterface());
            sb.append(",\"enum\":").append(c.isEnum());
            sb.append(",\"abstract\":").append(Modifier.isAbstract(c.getModifiers()) && !c.isInterface());
            sb.append(",\"super\":").append(q(c.getSuperclass() == null ? null : c.getSuperclass().getName()));
            sb.append(",\"ctors\":[");
            boolean first = true;
            if (!c.isInterface() && !c.isEnum() && !Modifier.isAbstract(c.getModifiers())) {
                for (Constructor<?> k : c.getConstructors()) {
                    if (!first) sb.append(',');
                    first = false;
                    sb.append("{\"key\":").append(q(key("<init>", k.getParameterTypes())))
                      .append(",\"params\":").append(paramsJson(k.getParameterTypes(), k.getParameters())).append('}');
                }
            }
            sb.append("],\"methods\":[");
            first = true;
            List<Method> ms = new ArrayList<Method>();
            for (Method m : c.getMethods()) if (!m.isSynthetic() && !m.isBridge()) ms.add(m);
            for (Method m : ms) {
                if (!first) sb.append(',');
                first = false;
                sb.append("{\"key\":").append(q(key(m.getName(), m.getParameterTypes())))
                  .append(",\"name\":").append(q(m.getName()))
                  .append(",\"ret\":").append(q(typeName(m.getReturnType())))
                  .append(",\"static\":").append(Modifier.isStatic(m.getModifiers()))
                  .append(",\"declaring\":").append(q(m.getDeclaringClass().getName()))
                  .append(",\"params\":").append(paramsJson(m.getParameterTypes(), m.getParameters())).append('}');
            }
            return sb.append("]}").toString();
        } catch (Throwable t) {
            return "{\"error\":" + q(String.valueOf(t)) + "}";
        }
    }

    // ----------------------------------------------------------------- Werte

    private static String formatValue(Object v) {
        if (v == null) return "null";
        if (v instanceof String) return q((String) v);
        if (v instanceof Character) return "'" + v + "'";
        if (v instanceof Number || v instanceof Boolean) return v.toString();
        return null; // Objekt
    }

    private static String toStr(Object v) {
        try {
            return String.valueOf(v);
        } catch (Throwable t) {
            return v.getClass().getName() + "@?";
        }
    }

    private static String newTemp(Object o) {
        String k = "$" + (++tempCounter);
        temps.put(k, o);
        return k;
    }

    private static Object lookup(String ref) {
        if (bench.containsKey(ref)) return bench.get(ref);
        return temps.get(ref);
    }

    /** JSON-Beschreibung eines Wertes (primitiv/String direkt, sonst Referenz). */
    private static String valueJson(Object v, Class<?> declared) {
        String f = formatValue(v);
        if (f != null) {
            return "{\"kind\":\"value\",\"text\":" + q(f) + ",\"type\":" + q(v == null || declared.isPrimitive() ? typeName(declared) : typeName(v.getClass())) + "}";
        }
        String ref = newTemp(v);
        return "{\"kind\":\"object\",\"ref\":" + q(ref) + ",\"type\":" + q(typeName(v.getClass()))
            + ",\"text\":" + q(toStr(v)) + "}";
    }

    private static String exceptionJson(Throwable t) {
        if (t instanceof InvocationTargetException && t.getCause() != null) t = t.getCause();
        System.err.print(trace(t));
        return "{\"kind\":\"exception\",\"type\":" + q(t.getClass().getName()) + ",\"message\":" + q(t.getMessage())
            + ",\"trace\":" + q(trace(t)) + "}";
    }

    // ------------------------------------------------------- Argument-Umwandlung

    private static Object parseArg(String text, Class<?> type) throws Throwable {
        String t = text.trim();
        if (t.isEmpty()) throw new IllegalArgumentException("Leerer Parameter (" + typeName(type) + ")");
        if (bench.containsKey(t) && !type.isPrimitive()) return bench.get(t);
        if (type == String.class && t.length() >= 2 && t.charAt(0) == '"' && t.charAt(t.length() - 1) == '"') {
            return parseStringArray("[" + t + "]").get(0);
        }
        try {
            if (type == int.class || type == Integer.class) return Integer.valueOf(t);
            if (type == long.class || type == Long.class) return Long.valueOf(t.replaceAll("[lL]$", ""));
            if (type == short.class || type == Short.class) return Short.valueOf(t);
            if (type == byte.class || type == Byte.class) return Byte.valueOf(t);
            if (type == double.class || type == Double.class) return Double.valueOf(t);
            if (type == float.class || type == Float.class) return Float.valueOf(t.replaceAll("[fF]$", ""));
            if (type == boolean.class || type == Boolean.class) {
                if (t.equals("true") || t.equals("false")) return Boolean.valueOf(t);
                throw new NumberFormatException(t);
            }
            if (type == char.class || type == Character.class) {
                if (t.length() == 3 && t.charAt(0) == '\'' && t.charAt(2) == '\'') return t.charAt(1);
                if (t.length() == 1) return t.charAt(0);
                throw new NumberFormatException(t);
            }
        } catch (NumberFormatException e) {
            // fällt zur Ausdrucksauswertung durch (z. B. "2 + 3" oder "1e3")
        }
        if (t.equals("null") && !type.isPrimitive()) return null;
        if (type.isArray() && t.startsWith("{")) return evalExpression("new " + sourceName(type) + t);
        return evalExpression(t);
    }

    private static Object[] parseArgs(String json, Class<?>[] types) throws Throwable {
        List<String> a = parseStringArray(json);
        if (a.size() != types.length) throw new IllegalArgumentException("Falsche Anzahl Parameter");
        Object[] r = new Object[types.length];
        for (int i = 0; i < r.length; i++) r[i] = parseArg(a.get(i), types[i]);
        return r;
    }

    // ------------------------------------------------------- Objekte erzeugen/aufrufen

    private static String typeKey(Class<?>[] types) {
        return key("", types);
    }

    public static String create(String className, String ctorKey, String argsJson, String instName) {
        try {
            Class<?> c = findClass(className);
            Constructor<?> found = null;
            for (Constructor<?> k : c.getConstructors()) {
                if (key("<init>", k.getParameterTypes()).equals(ctorKey)) found = k;
            }
            if (found == null) return "{\"kind\":\"exception\",\"type\":\"NoSuchMethod\",\"message\":" + q(ctorKey) + "}";
            Object[] args = parseArgs(argsJson, found.getParameterTypes());
            Object o = found.newInstance(args);
            bench.put(instName, o);
            benchTypes.put(instName, sourceName(c));
            return "{\"kind\":\"created\",\"name\":" + q(instName) + ",\"type\":" + q(c.getName()) + "}";
        } catch (Throwable t) {
            return exceptionJson(t);
        }
    }

    /** target: Name auf der Bench, oder Temp-Referenz; leer bei statischen Methoden. */
    public static String call(String target, String className, String methodKey, String argsJson) {
        try {
            Class<?> c = target.isEmpty() ? findClass(className) : lookup(target).getClass();
            Method found = null;
            for (Method m : c.getMethods()) {
                if (key(m.getName(), m.getParameterTypes()).equals(methodKey)) { found = m; break; }
            }
            if (found == null) return "{\"kind\":\"exception\",\"type\":\"NoSuchMethod\",\"message\":" + q(methodKey) + "}";
            Object[] args = parseArgs(argsJson, found.getParameterTypes());
            found.setAccessible(true);
            Object r = found.invoke(Modifier.isStatic(found.getModifiers()) ? null : lookup(target), args);
            if (found.getReturnType() == void.class) return "{\"kind\":\"void\"}";
            return valueJson(r, found.getReturnType());
        } catch (Throwable t) {
            return exceptionJson(t);
        }
    }

    /** Verschiebt ein Ergebnisobjekt (Temp-Referenz) auf die Objekt-Bench. */
    public static String toBench(String ref, String name) {
        Object o = temps.get(ref);
        if (o == null) return "{\"ok\":false}";
        bench.put(name, o);
        benchTypes.put(name, sourceName(o.getClass()));
        return "{\"ok\":true}";
    }

    public static String removeObject(String name) {
        bench.remove(name);
        benchTypes.remove(name);
        return "ok";
    }

    public static String clearBench() {
        bench.clear();
        benchTypes.clear();
        temps.clear();
        return "ok";
    }

    // ---------------------------------------------------------------- Inspektor

    private static void addField(StringBuilder sb, boolean[] first, String name, String type, boolean isStatic,
                                 String owner, Object v) {
        if (!first[0]) sb.append(',');
        first[0] = false;
        String f = formatValue(v);
        sb.append("{\"name\":").append(q(name)).append(",\"type\":").append(q(type))
          .append(",\"static\":").append(isStatic).append(",\"owner\":").append(q(owner));
        if (f != null) {
            sb.append(",\"text\":").append(q(f));
        } else {
            sb.append(",\"text\":").append(q("<Objekt vom Typ " + typeName(v.getClass()) + ">"))
              .append(",\"ref\":").append(q(newTemp(v)));
        }
        sb.append('}');
    }

    public static String inspect(String ref) {
        try {
            Object o = lookup(ref);
            if (o == null) return "{\"error\":\"Objekt nicht gefunden\"}";
            Class<?> c = o.getClass();
            StringBuilder sb = new StringBuilder("{\"type\":").append(q(c.getName()))
                .append(",\"array\":").append(c.isArray()).append(",\"fields\":[");
            boolean[] first = { true };
            if (c.isArray()) {
                int n = Array.getLength(o);
                for (int i = 0; i < n && i < 500; i++) {
                    Object e = Array.get(o, i);
                    addField(sb, first, "[" + i + "]", typeName(c.getComponentType()), false, "", e);
                }
            } else {
                List<Class<?>> chain = new ArrayList<Class<?>>();
                for (Class<?> k = c; k != null && k != Object.class; k = k.getSuperclass()) chain.add(0, k);
                for (Class<?> k : chain) {
                    if (k.getName().startsWith("java.") && k != c) continue;
                    for (Field f : k.getDeclaredFields()) {
                        if (f.isSynthetic()) continue;
                        try {
                            f.setAccessible(true);
                            Object v = f.get(Modifier.isStatic(f.getModifiers()) ? null : o);
                            addField(sb, first, f.getName(), typeName(f.getType()), Modifier.isStatic(f.getModifiers()),
                                k.getName(), v);
                        } catch (Throwable t) {
                            addField(sb, first, f.getName(), typeName(f.getType()), Modifier.isStatic(f.getModifiers()),
                                k.getName(), "<nicht lesbar>");
                        }
                    }
                }
            }
            return sb.append("],\"string\":").append(q(toStr(o))).append('}').toString();
        } catch (Throwable t) {
            return "{\"error\":" + q(String.valueOf(t)) + "}";
        }
    }

    public static String benchJson() {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (Map.Entry<String, Object> e : bench.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"name\":").append(q(e.getKey())).append(",\"class\":").append(q(e.getValue().getClass().getName()))
              .append(",\"type\":").append(q(typeName(e.getValue().getClass()))).append('}');
        }
        return sb.append(']').toString();
    }

    // ------------------------------------------------------------------ Codepad

    private static final Set<String> PRIMS = new HashSet<String>(java.util.Arrays.asList(
        "int", "long", "short", "byte", "double", "float", "boolean", "char"));
    private static final Pattern DECL = Pattern.compile(
        "^\\s*(?!return\\b|new\\b|throw\\b|else\\b)([A-Za-z_][\\w.]*(?:<[^=;]*>)?(?:\\[\\])*)\\s+([A-Za-z_]\\w*)\\s*=\\s*([\\s\\S]*?);?\\s*$");

    private static String envPrelude(Set<String> skip) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, Object> e : bench.entrySet()) {
            if (skip.contains(e.getKey())) continue;
            String t = benchTypes.get(e.getKey());
            Class<?> c = e.getValue().getClass();
            if (t == null || c.isAnonymousClass() || c.isSynthetic() || c.getName().matches(".*\\$\\d.*")) t = "Object";
            sb.append(t).append(' ').append(e.getKey()).append(" = (").append(t).append(") $env.get(")
              .append(q(e.getKey())).append(");\n");
        }
        return sb.toString();
    }

    private static final class EvalFailure extends Exception {
        EvalFailure(String m) { super(m); }
    }

    private static Object runSnippet(String body, Set<String> skip, Map<String, Object> env) throws Throwable {
        String cls = "$Eval" + (++evalCounter);
        String src = "public class " + cls + " {\n public static Object run(java.util.Map<String,Object> $env) throws Throwable {\n"
            + envPrelude(skip) + body + "\n }\n}\n";
        Map<String, String> files = new LinkedHashMap<String, String>();
        files.put(cls + ".java", src);
        // Benutzerklassen sind per Klassenlader sichtbar; der Compiler kennt sie über LibEnv aus classBytes:
        Outcome o = runCompilerWithUserClasses(files);
        if (o.errorCount > 0) {
            // Zeilen-Offset der Hilfsklasse abziehen ist nicht nötig; nur die Meldung zeigen
            throw new EvalFailure(o.firstError == null ? "Übersetzungsfehler" : o.firstError);
        }
        EvalLoader el = new EvalLoader(o.classes);
        Class<?> k = el.loadClass(cls);
        try {
            return k.getMethod("run", Map.class).invoke(null, env);
        } catch (InvocationTargetException ex) {
            throw ex.getCause();
        }
    }

    private static final class EvalLoader extends ClassLoader {
        private final Map<String, byte[]> own;
        EvalLoader(Map<String, byte[]> own) {
            super(loader);
            this.own = own;
        }
        @Override protected Class<?> findClass(String name) throws ClassNotFoundException {
            byte[] b = own.get(name);
            if (b == null) throw new ClassNotFoundException(name);
            return defineClass(name, b, 0, b.length);
        }
    }

    /** Wie runCompiler, aber die bereits übersetzten Benutzerklassen sind als Bibliothek sichtbar. */
    private static Outcome runCompilerWithUserClasses(Map<String, String> files) {
        final Outcome out = new Outcome();
        List<ICompilationUnit> units = new ArrayList<ICompilationUnit>();
        Set<String> names = new HashSet<String>();
        for (Map.Entry<String, String> e : files.entrySet()) {
            units.add(new Unit(e.getKey(), e.getValue()));
            names.add(e.getKey().substring(0, e.getKey().length() - 5));
        }
        INameEnvironment env = new LibEnv(names) {
            @Override public NameEnvironmentAnswer findType(char[][] compoundTypeName) {
                NameEnvironmentAnswer a = userType(join(compoundTypeName));
                return a != null ? a : super.findType(compoundTypeName);
            }
            @Override public NameEnvironmentAnswer findType(char[] typeName, char[][] packageName) {
                if (packageName == null || packageName.length == 0) {
                    NameEnvironmentAnswer a = userType(new String(typeName));
                    if (a != null) return a;
                }
                return super.findType(typeName, packageName);
            }
        };
        ICompilerRequestor requestor = new ICompilerRequestor() {
            @Override public void acceptResult(CompilationResult result) {
                CategorizedProblem[] probs = result.getProblems();
                boolean hasError = false;
                if (probs != null) {
                    for (CategorizedProblem p : probs) {
                        if (p.isError()) {
                            hasError = true;
                            out.errorCount++;
                            if (out.firstError == null) out.firstError = p.getMessage();
                        }
                    }
                }
                if (!hasError) {
                    for (ClassFile cf : result.getClassFiles()) {
                        out.classes.put(new String(cf.fileName()).replace('/', '.'), cf.getBytes());
                    }
                }
            }
        };
        new Compiler(env, DefaultErrorHandlingPolicies.proceedWithAllProblems(), options(), requestor,
            new DefaultProblemFactory(Locale.GERMAN)).compile(units.toArray(new ICompilationUnit[0]));
        return out;
    }

    private static NameEnvironmentAnswer userType(String dotted) {
        byte[] b = classBytes.get(dotted);
        if (b == null) return null;
        try {
            return new NameEnvironmentAnswer(new ClassFileReader(b, (dotted.replace('.', '/') + ".class").toCharArray(), true), null);
        } catch (Exception e) {
            return null;
        }
    }

    private static Object evalExpression(String expr) throws Throwable {
        Map<String, Object> env = new HashMap<String, Object>(bench);
        return runSnippet("return (" + expr + ");", new HashSet<String>(), env);
    }

    /**
     * Wertet eine Codepad-Eingabe aus (Ausdruck oder Anweisung).
     * Deklarationen der Form "Typ name = ..." legen ein Objekt auf der Bench ab.
     */
    public static String eval(String code) {
        try {
            String c = code.trim();
            if (c.isEmpty()) return "{\"kind\":\"void\"}";
            Map<String, Object> env = new HashMap<String, Object>(bench);
            Matcher m = DECL.matcher(c);
            if (m.matches() && !PRIMS.contains(m.group(1)) && !c.startsWith("var ")) {
                String type = m.group(1), name = m.group(2), init = m.group(3);
                Set<String> skip = new HashSet<String>();
                skip.add(name);
                Object v = runSnippet(type + " " + name + " = " + init + ";\nreturn " + name + ";", skip, env);
                if (v != null && formatValue(v) == null) {
                    bench.put(name, v);
                    benchTypes.put(name, type);
                    return "{\"kind\":\"created\",\"name\":" + q(name) + ",\"type\":" + q(v.getClass().getName()) + "}";
                }
                return valueJson(v, Object.class);
            }
            boolean stmtFirst = c.endsWith(";") || c.endsWith("}") || c.startsWith("var ")
                || (m.matches() && PRIMS.contains(m.group(1)));
            Object result;
            boolean isVoid = false;
            String bare = c.endsWith(";") ? c.substring(0, c.length() - 1).trim() : c;
            try {
                if (stmtFirst && c.endsWith(";") && !bare.contains(";") && !bare.startsWith("var ")
                    && !(m.matches() && PRIMS.contains(m.group(1)))) {
                    try {
                        result = runSnippet("return (" + bare + ");", new HashSet<String>(), env);
                    } catch (EvalFailure ef) {
                        result = runSnippet(c + "\nreturn null;", new HashSet<String>(), env);
                        isVoid = true;
                    }
                } else if (stmtFirst) {
                    result = runSnippet(c + "\nreturn null;", new HashSet<String>(), env);
                    isVoid = true;
                } else {
                    try {
                        result = runSnippet("return (" + c + ");", new HashSet<String>(), env);
                    } catch (EvalFailure ef) {
                        try {
                            result = runSnippet(c + ";\nreturn null;", new HashSet<String>(), env);
                            isVoid = true;
                        } catch (EvalFailure ef2) {
                            throw ef;
                        }
                    }
                }
            } catch (EvalFailure ef) {
                return "{\"kind\":\"error\",\"message\":" + q(ef.getMessage()) + "}";
            }
            if (isVoid) return "{\"kind\":\"void\"}";
            return valueJson(result, Object.class);
        } catch (Throwable t) {
            return exceptionJson(t);
        }
    }
}
