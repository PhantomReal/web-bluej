import com.sun.net.httpserver.HttpServer;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Entwicklungs-Server: stellt die Bridge-Methoden per HTTP bereit, damit die Oberfläche
 * ohne CheerpJ getestet werden kann (Aufruf der Seite mit ?dev=1).
 * Start: java -cp web/jars/bluejweb.jar:web/jars/ecj.jar java/dev/DevServer.java
 */
public class DevServer {
    public static void main(String[] args) throws Exception {
        PrintStream log = new PrintStream(new FileOutputStream(FileDescriptor.out), true);
        Class<?> bridge = Class.forName("bluej.web.Bridge");
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 8099;
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
        server.createContext("/", ex -> {
            ex.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
            ex.getResponseHeaders().add("Access-Control-Allow-Headers", "*");
            if ("OPTIONS".equals(ex.getRequestMethod())) { ex.sendResponseHeaders(204, -1); ex.close(); return; }
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String out;
            try {
                String m = field(body, "m");
                List<String> a = strings(body.substring(body.indexOf("\"a\"")));
                Class<?>[] types = new Class<?>[a.size()];
                java.util.Arrays.fill(types, String.class);
                Method meth = bridge.getMethod(m, types);
                out = String.valueOf(meth.invoke(null, a.toArray()));
            } catch (Throwable t) {
                out = "{\"kind\":\"exception\",\"type\":\"DevServer\",\"message\":\"" + String.valueOf(t).replace("\"", "'") + "\"}";
            }
            byte[] bytes = out.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "text/plain; charset=utf-8");
            ex.sendResponseHeaders(200, bytes.length);
            ex.getResponseBody().write(bytes);
            ex.close();
        });
        server.start();
        log.println("DevServer läuft auf http://127.0.0.1:" + port);
    }

    static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
        return m.find() ? m.group(1) : "";
    }

    static List<String> strings(String json) throws Exception {
        Method pm = Class.forName("bluej.web.Bridge").getDeclaredMethod("parseStringArray", String.class);
        pm.setAccessible(true);
        @SuppressWarnings("unchecked")
        List<String> r = (List<String>) pm.invoke(null, json.substring(json.indexOf('[')));
        return new ArrayList<>(r);
    }
}
