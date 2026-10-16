package io.github.fabianbeck.labelanything;

/**
 * Chooses the native backend (Java 17–21 version of this class: JNI only). The
 * multi-release JAR replaces it on Java 22+ ({@code META-INF/versions/22}) with a version
 * that prefers FFM. The system property {@code labelanything.backend} ({@code auto},
 * {@code ffm}, {@code jni}) overrides the choice.
 */
final class Backends {
  static final String PROPERTY = "labelanything.backend";

  private static NativeBackend jni;
  private static volatile NativeBackend selected;

  private Backends() {}

  /** The backend for this JVM (chosen once). */
  static NativeBackend get() {
    NativeBackend b = selected;
    return b != null ? b : select();
  }

  private static synchronized NativeBackend select() {
    if (selected == null) {
      String choice = System.getProperty(PROPERTY, "auto").trim().toLowerCase(java.util.Locale.ROOT);
      selected = switch (choice) {
        case "auto", "", "jni" -> jni();
        case "ffm" -> ffm();
        default -> throw new LabelAnythingException(
            "-D" + PROPERTY + "=" + choice + ": expected auto, ffm or jni", null);
      };
    }
    return selected;
  }

  /** Whether this JVM can use the FFM backend. */
  static boolean ffmSupported() {
    return false;
  }

  /** The FFM backend: needs Java 22+ (and this JAR's {@code META-INF/versions/22}). */
  static NativeBackend ffm() {
    throw new LabelAnythingException("the FFM backend needs Java 22 or newer (running "
        + Runtime.version() + "); use the JNI backend", null);
  }

  /** The JNI backend. */
  static synchronized NativeBackend jni() {
    if (jni == null) {
      try {
        jni = new JniBackend(NativeLibrary.path());
      } catch (LabelAnythingException e) {
        throw e;
      } catch (RuntimeException | LinkageError e) {
        throw new LabelAnythingException("cannot load the JNI backend: " + e, e);
      }
    }
    return jni;
  }
}
