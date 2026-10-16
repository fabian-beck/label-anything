package io.github.fabianbeck.labelanything;

/**
 * Chooses the native backend (Java 22+ version of this class, in {@code
 * META-INF/versions/22} of the multi-release JAR): FFM by default, JNI as fallback. The
 * system property {@code labelanything.backend} ({@code auto}, {@code ffm}, {@code jni})
 * overrides the choice.
 */
final class Backends {
  static final String PROPERTY = "labelanything.backend";

  private static NativeBackend jni;
  private static NativeBackend ffm;
  private static NativeBackend selected;

  private Backends() {}

  /** The backend for this JVM (chosen once). */
  static synchronized NativeBackend get() {
    if (selected == null) {
      String choice = System.getProperty(PROPERTY, "auto").trim().toLowerCase(java.util.Locale.ROOT);
      selected = switch (choice) {
        case "auto", "" -> auto();
        case "ffm" -> ffm();
        case "jni" -> jni();
        default -> throw new LabelAnythingException(
            "-D" + PROPERTY + "=" + choice + ": expected auto, ffm or jni", null);
      };
    }
    return selected;
  }

  private static NativeBackend auto() {
    try {
      return ffm();
    } catch (LabelAnythingException ffmFailure) {
      try {
        return jni();
      } catch (LabelAnythingException jniFailure) {
        jniFailure.addSuppressed(ffmFailure);
        throw jniFailure;
      }
    }
  }

  /** Whether this JVM can use the FFM backend. */
  static boolean ffmSupported() {
    return true;
  }

  /** The FFM backend (the C ABI through {@code Linker.nativeLinker()}). */
  static synchronized NativeBackend ffm() {
    if (ffm == null) {
      try {
        ffm = new FfmBackend(NativeLibrary.path());
      } catch (LabelAnythingException e) {
        throw e;
      } catch (RuntimeException | LinkageError e) {
        throw new LabelAnythingException("cannot load the FFM backend: " + e, e);
      }
    }
    return ffm;
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
