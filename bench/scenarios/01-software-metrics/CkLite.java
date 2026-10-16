// CK-style class metrics computed on the javac syntax tree (JDK 11+, no dependencies).
//
//   java CkLite.java <source-dir> <out.csv>
//
// A documented approximation of the CK tool (Aniche, https://github.com/mauricioaniche/ck),
// used because CK's fat jar is not published on Maven Central and its dependency closure
// (Eclipse JDT + platform) cannot be fetched reliably from the benchmark environment.
// Metrics per class (top-level, named nested "Outer$Inner", anonymous "Outer$AnonymousN"),
// following CK's definitions but without type attribution:
//   cbo  number of distinct types referenced (fields, locals, parameters, return/throws
//        types, extends/implements, instantiations, casts, instanceof, type arguments,
//        class literals, static member access); java.* / javax.* types, primitives, type
//        variables and the class itself are ignored. Simple names are resolved through
//        single-type imports, types of the same compilation unit / package, and java.lang.
//   rfc  number of distinct method invocations, keyed by receiver + name + argument count
//        (CK resolves bindings; overloads with the same arity are merged here as in CK).
//   wmc  sum over methods/constructors/initializers of 1 + branches (if, for, foreach,
//        while, do, case, catch, ?:, &&, ||).
//   loc  non-blank, non-comment lines of the class declaration.
//   nom  number of methods (incl. constructors); nof number of fields.
// Output: CSV sorted by class name; deterministic.
import com.sun.source.tree.*;
import com.sun.source.util.*;

import javax.tools.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.*;

public class CkLite {
    static final Set<String> JAVA_LANG = new HashSet<>(Arrays.asList(
        "String", "Object", "Integer", "Long", "Boolean", "Double", "Float", "Short", "Byte", "Character",
        "Math", "StrictMath", "System", "Thread", "Runnable", "Exception", "RuntimeException", "Error",
        "Throwable", "Iterable", "Class", "Enum", "Void", "Number", "StringBuilder", "StringBuffer",
        "IllegalArgumentException", "IllegalStateException", "NullPointerException",
        "UnsupportedOperationException", "IndexOutOfBoundsException", "ArrayIndexOutOfBoundsException",
        "StringIndexOutOfBoundsException", "ClassCastException", "InterruptedException",
        "CloneNotSupportedException", "Override", "Deprecated", "SuppressWarnings", "SafeVarargs",
        "FunctionalInterface", "Comparable", "CharSequence", "AutoCloseable", "Cloneable", "ThreadLocal",
        "InheritableThreadLocal", "Process", "ProcessBuilder", "Runtime", "SecurityException",
        "ArithmeticException", "NumberFormatException", "StackTraceElement", "ClassLoader", "Package",
        "AssertionError", "OutOfMemoryError", "StackOverflowError", "ReflectiveOperationException",
        "ClassNotFoundException", "NoSuchMethodException", "NoSuchFieldException", "IllegalAccessException",
        "InstantiationException", "NegativeArraySizeException", "ArrayStoreException", "LinkageError",
        "NoClassDefFoundError", "UnsatisfiedLinkError", "VirtualMachineError", "ExceptionInInitializerError",
        "IllegalMonitorStateException", "Appendable", "Readable", "Iterable", "ThreadGroup", "SecurityManager",
        "UnsupportedClassVersionError", "IncompatibleClassChangeError", "AbstractMethodError", "InternalError",
        "Record", "Module", "ModuleLayer", "StackWalker", "ThreadDeath", "TypeNotPresentException",
        "EnumConstantNotPresentException", "IllegalCallerException", "IllegalThreadStateException"));

    static final class Metrics {
        String name, type, file;
        final TreeSet<String> deps = new TreeSet<>();
        final TreeSet<String> calls = new TreeSet<>();
        int wmc, loc, nom, nof;
    }

    static final Map<String, Metrics> RESULTS = new TreeMap<>();
    static final Set<String> PROJECT_TYPES = new TreeSet<>();   // FQCNs with '.' separators (sorted: deterministic)
    static SourcePositions POS;

    public static void main(String[] args) throws Exception {
        Path src = Paths.get(args[0]).toAbsolutePath().normalize();
        Path out = Paths.get(args[1]);
        List<Path> files;
        try (Stream<Path> s = Files.walk(src)) {
            files = s.filter(p -> p.toString().endsWith(".java")).sorted().collect(Collectors.toList());
        }
        JavaCompiler jc = ToolProvider.getSystemJavaCompiler();
        StandardJavaFileManager fm = jc.getStandardFileManager(null, Locale.ROOT, StandardCharsets.UTF_8);
        JavacTask task = (JavacTask) jc.getTask(null, fm, d -> { }, List.of("-proc:none"), null,
            fm.getJavaFileObjectsFromPaths(files));
        List<CompilationUnitTree> units = new ArrayList<>();
        for (CompilationUnitTree u : task.parse()) units.add(u);
        POS = Trees.instance(task).getSourcePositions();
        units.sort(Comparator.comparing(u -> u.getSourceFile().getName()));
        for (CompilationUnitTree u : units) indexTypes(u);
        for (CompilationUnitTree u : units) {
            String text = u.getSourceFile().getCharContent(true).toString();
            String rel = src.relativize(Paths.get(u.getSourceFile().toUri())).toString().replace('\\', '/');
            new UnitScanner(u, text, rel).scan(u, null);
        }
        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(out, StandardCharsets.UTF_8))) {
            w.println("class,type,file,cbo,rfc,wmc,loc,nom,nof");
            for (Metrics m : RESULTS.values()) {
                w.println(String.join(",", m.name, m.type, m.file, Integer.toString(m.deps.size()),
                    Integer.toString(m.calls.size()), Integer.toString(m.wmc), Integer.toString(m.loc),
                    Integer.toString(m.nom), Integer.toString(m.nof)));
            }
        }
        System.err.println("CkLite: " + files.size() + " files, " + RESULTS.size() + " classes");
    }

    static String pkgOf(CompilationUnitTree u) {
        return u.getPackageName() == null ? "" : u.getPackageName().toString();
    }

    static void indexTypes(CompilationUnitTree u) {
        String pkg = pkgOf(u);
        new TreeScanner<Void, String>() {
            @Override public Void visitClass(ClassTree t, String outer) {
                String n = t.getSimpleName().toString();
                if (n.isEmpty()) return super.visitClass(t, outer);
                String fq = outer == null ? (pkg.isEmpty() ? n : pkg + "." + n) : outer + "." + n;
                PROJECT_TYPES.add(fq);
                for (Tree m : t.getMembers()) scan(m, fq);
                return null;
            }
        }.scan(u, null);
    }

    /** Scans one compilation unit; every class body is measured by its own ClassMeasurer. */
    static final class UnitScanner extends TreeScanner<Void, Void> {
        final CompilationUnitTree unit;
        final String text, file, pkg;
        final Map<String, String> imports = new HashMap<>();
        final List<String> starImports = new ArrayList<>();
        final Set<String> unitTypes = new HashSet<>();

        UnitScanner(CompilationUnitTree u, String text, String file) {
            this.unit = u; this.text = text; this.file = file; this.pkg = pkgOf(u);
            for (ImportTree it : u.getImports()) {
                String q = it.getQualifiedIdentifier().toString();
                if (it.isStatic()) continue;
                if (q.endsWith(".*")) starImports.add(q.substring(0, q.length() - 2));
                else imports.put(q.substring(q.lastIndexOf('.') + 1), q);
            }
            new TreeScanner<Void, Void>() {
                @Override public Void visitClass(ClassTree t, Void v) {
                    if (!t.getSimpleName().toString().isEmpty()) unitTypes.add(t.getSimpleName().toString());
                    return super.visitClass(t, v);
                }
            }.scan(u, null);
        }

        @Override public Void visitClass(ClassTree t, Void v) {
            String n = t.getSimpleName().toString();
            String fq = pkg.isEmpty() ? n : pkg + "." + n;
            measure(t, fq, kindOf(t), Collections.emptySet());
            return null;
        }

        String kindOf(ClassTree t) {
            switch (t.getKind()) {
                case INTERFACE: return "interface";
                case ENUM: return "enum";
                case ANNOTATION_TYPE: return "annotation";
                default: return "class";
            }
        }

        void measure(ClassTree t, String name, String type, Set<String> outerTypeVars) {
            Metrics m = new Metrics();
            m.name = name; m.type = type; m.file = file;
            RESULTS.put(name, m);
            Set<String> tvars = new HashSet<>(outerTypeVars);
            for (TypeParameterTree tp : t.getTypeParameters()) tvars.add(tp.getName().toString());
            ClassMeasurer cm = new ClassMeasurer(this, m, name, tvars);
            if (t.getExtendsClause() != null) cm.type(t.getExtendsClause());
            for (Tree i : t.getImplementsClause()) cm.type(i);
            for (TypeParameterTree tp : t.getTypeParameters()) for (Tree b : tp.getBounds()) cm.type(b);
            for (Tree mem : t.getMembers()) cm.scan(mem, null);
            m.loc = loc(t);
            m.deps.remove(name.replace('$', '.'));
        }

        int loc(Tree t) {
            long start = startOf(t), end = endOf(t);
            if (start < 0 || end < 0 || end > text.length()) return 0;
            String body = text.substring((int) start, (int) end);
            int count = 0;
            boolean inBlock = false;
            for (String raw : body.split("\n", -1)) {
                String line = raw.trim();
                StringBuilder code = new StringBuilder();
                int i = 0;
                while (i < line.length()) {
                    if (inBlock) {
                        int e = line.indexOf("*/", i);
                        if (e < 0) { i = line.length(); } else { inBlock = false; i = e + 2; }
                    } else if (line.startsWith("//", i)) {
                        break;
                    } else if (line.startsWith("/*", i)) {
                        inBlock = true; i += 2;
                    } else {
                        code.append(line.charAt(i)); i++;
                    }
                }
                if (code.toString().trim().length() > 0) count++;
            }
            return count;
        }

        long startOf(Tree t) { return POS.getStartPosition(unit, t); }
        long endOf(Tree t) { return POS.getEndPosition(unit, t); }

        String resolve(String simple, Set<String> tvars, String self) {
            if (tvars.contains(simple)) return null;
            String imp = imports.get(simple);
            if (imp != null) return imp;
            if (unitTypes.contains(simple)) {
                for (String fq : PROJECT_TYPES) if (fq.endsWith("." + simple) && fq.startsWith(pkg + ".")) return fq;
                return pkg + "." + simple;
            }
            String same = pkg.isEmpty() ? simple : pkg + "." + simple;
            if (PROJECT_TYPES.contains(same)) return same;
            if (JAVA_LANG.contains(simple)) return "java.lang." + simple;
            List<String> hits = new ArrayList<>();
            for (String sp : starImports) if (PROJECT_TYPES.contains(sp + "." + simple)) hits.add(sp + "." + simple);
            if (hits.size() == 1) return hits.get(0);
            return simple;
        }
    }

    /** Measures one class body; nested classes are measured separately. */
    static final class ClassMeasurer extends TreeScanner<Void, Void> {
        final UnitScanner us;
        final Metrics m;
        final String self;
        final Set<String> tvars;
        int anon = 0;
        int depth = 0;           // method nesting (for wmc attribution)
        int current = 0;         // complexity of the method being scanned

        ClassMeasurer(UnitScanner us, Metrics m, String self, Set<String> tvars) {
            this.us = us; this.m = m; this.self = self; this.tvars = tvars;
        }

        void dep(String fq) {
            if (fq == null || fq.isEmpty()) return;
            if (fq.startsWith("java.") || fq.startsWith("javax.")) return;
            m.deps.add(fq);
        }

        void type(Tree t) {
            if (t == null) return;
            switch (t.getKind()) {
                case PRIMITIVE_TYPE: return;
                case ARRAY_TYPE: type(((ArrayTypeTree) t).getType()); return;
                case PARAMETERIZED_TYPE: {
                    ParameterizedTypeTree p = (ParameterizedTypeTree) t;
                    type(p.getType());
                    for (Tree a : p.getTypeArguments()) type(a);
                    return;
                }
                case UNBOUNDED_WILDCARD: return;
                case EXTENDS_WILDCARD: case SUPER_WILDCARD: type(((WildcardTree) t).getBound()); return;
                case UNION_TYPE: for (Tree a : ((UnionTypeTree) t).getTypeAlternatives()) type(a); return;
                case INTERSECTION_TYPE: for (Tree a : ((IntersectionTypeTree) t).getBounds()) type(a); return;
                case ANNOTATED_TYPE: type(((AnnotatedTypeTree) t).getUnderlyingType()); return;
                case IDENTIFIER: {
                    String n = ((IdentifierTree) t).getName().toString();
                    if (n.equals("var")) return;
                    dep(us.resolve(n, tvars, self));
                    return;
                }
                case MEMBER_SELECT: {
                    String q = t.toString();
                    String first = q.contains(".") ? q.substring(0, q.indexOf('.')) : q;
                    if (!first.isEmpty() && Character.isLowerCase(first.charAt(0))) { dep(q); return; }
                    String head = us.resolve(first, tvars, self);
                    dep(head == null ? null : head + q.substring(first.length()));
                    return;
                }
                default: return;
            }
        }

        boolean looksLikeType(String n) {
            if (n.isEmpty() || !Character.isUpperCase(n.charAt(0))) return false;
            for (int i = 1; i < n.length(); i++) if (Character.isLowerCase(n.charAt(i))) return true;
            return false;
        }

        @Override public Void visitClass(ClassTree t, Void v) {
            String n = t.getSimpleName().toString();
            us.measure(t, self + "$" + n, "innerclass", tvars);
            return null;
        }

        @Override public Void visitNewClass(NewClassTree t, Void v) {
            type(t.getIdentifier());
            for (Tree a : t.getTypeArguments()) type(a);
            if (t.getEnclosingExpression() != null) scan(t.getEnclosingExpression(), v);
            for (ExpressionTree a : t.getArguments()) scan(a, v);
            if (t.getClassBody() != null) {
                anon++;
                String an = self + "$Anonymous" + anon;
                us.measure(t.getClassBody(), an, "anonymous", tvars);
            }
            return null;
        }

        @Override public Void visitVariable(VariableTree t, Void v) {
            if (depth == 0) m.nof++;
            type(t.getType());
            return super.visitVariable(t, v);
        }

        @Override public Void visitMethod(MethodTree t, Void v) {
            m.nom++;
            Set<String> saved = new HashSet<>(tvars);
            for (TypeParameterTree tp : t.getTypeParameters()) tvars.add(tp.getName().toString());
            type(t.getReturnType());
            for (ExpressionTree e : t.getThrows()) type(e);
            for (VariableTree p : t.getParameters()) type(p.getType());
            depth++;
            int before = current;
            current = 1;
            if (t.getBody() != null) scan(t.getBody(), v);
            for (VariableTree p : t.getParameters()) if (p.getInitializer() != null) scan(p.getInitializer(), v);
            m.wmc += current;
            current = before;
            depth--;
            tvars.clear();
            tvars.addAll(saved);
            return null;
        }

        @Override public Void visitBlock(BlockTree t, Void v) {
            if (depth == 0) {  // initializer block of the class
                depth++;
                int before = current;
                current = 1;
                super.visitBlock(t, v);
                m.wmc += current;
                current = before;
                depth--;
                return null;
            }
            return super.visitBlock(t, v);
        }

        @Override public Void visitTypeCast(TypeCastTree t, Void v) { type(t.getType()); return super.visitTypeCast(t, v); }
        @Override public Void visitInstanceOf(InstanceOfTree t, Void v) { type(t.getType()); return super.visitInstanceOf(t, v); }
        @Override public Void visitIf(IfTree t, Void v) { current++; return super.visitIf(t, v); }
        @Override public Void visitForLoop(ForLoopTree t, Void v) { current++; return super.visitForLoop(t, v); }
        @Override public Void visitEnhancedForLoop(EnhancedForLoopTree t, Void v) { current++; return super.visitEnhancedForLoop(t, v); }
        @Override public Void visitWhileLoop(WhileLoopTree t, Void v) { current++; return super.visitWhileLoop(t, v); }
        @Override public Void visitDoWhileLoop(DoWhileLoopTree t, Void v) { current++; return super.visitDoWhileLoop(t, v); }
        @Override public Void visitCatch(CatchTree t, Void v) { current++; return super.visitCatch(t, v); }
        @Override public Void visitConditionalExpression(ConditionalExpressionTree t, Void v) { current++; return super.visitConditionalExpression(t, v); }
        @Override public Void visitCase(CaseTree t, Void v) {
            if (!t.getExpressions().isEmpty()) current++;
            return super.visitCase(t, v);
        }
        @Override public Void visitBinary(BinaryTree t, Void v) {
            if (t.getKind() == Tree.Kind.CONDITIONAL_AND || t.getKind() == Tree.Kind.CONDITIONAL_OR) current++;
            return super.visitBinary(t, v);
        }

        @Override public Void visitMethodInvocation(MethodInvocationTree t, Void v) {
            ExpressionTree sel = t.getMethodSelect();
            String recv, name;
            if (sel instanceof MemberSelectTree) {
                MemberSelectTree ms = (MemberSelectTree) sel;
                name = ms.getIdentifier().toString();
                ExpressionTree e = ms.getExpression();
                if (e instanceof IdentifierTree) {
                    recv = ((IdentifierTree) e).getName().toString();
                    if (looksLikeType(recv)) dep(us.resolve(recv, tvars, self));
                } else if (e instanceof MemberSelectTree) {
                    recv = e.toString();
                } else {
                    recv = "(" + e.getKind().name().toLowerCase(Locale.ROOT) + ")";
                }
            } else {
                recv = "this";
                name = sel.toString();
            }
            for (Tree a : t.getTypeArguments()) type(a);
            m.calls.add(recv + "." + name + "/" + t.getArguments().size());
            return super.visitMethodInvocation(t, v);
        }

        @Override public Void visitMemberSelect(MemberSelectTree t, Void v) {
            ExpressionTree e = t.getExpression();
            if (t.getIdentifier().contentEquals("class")) type(e);
            else if (e instanceof IdentifierTree) {
                String n = ((IdentifierTree) e).getName().toString();
                if (looksLikeType(n)) dep(us.resolve(n, tvars, self));
            }
            return super.visitMemberSelect(t, v);
        }

        @Override public Void visitMemberReference(MemberReferenceTree t, Void v) {
            ExpressionTree e = t.getQualifierExpression();
            if (e instanceof IdentifierTree && looksLikeType(((IdentifierTree) e).getName().toString())) type(e);
            return super.visitMemberReference(t, v);
        }

        @Override public Void visitLambdaExpression(LambdaExpressionTree t, Void v) {
            for (VariableTree p : t.getParameters()) if (p.getType() != null) type(p.getType());
            return scan(t.getBody(), v);
        }
    }

}
