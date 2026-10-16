package io.github.fabianbeck.labelanything;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Function;

/**
 * Finds {@code liblabelanything} (built with the cargo feature {@code jni}, so that one
 * file serves both the FFM and the JNI path), in this order:
 *
 * <ol>
 *   <li>the system property {@code labelanything.library.path}: the library file, or a
 *       directory containing it;
 *   <li>the directories of {@code java.library.path};
 *   <li>the resource {@code native/{os}-{arch}/{file}} bundled in the JAR, extracted to a
 *       temporary file (directory: {@code labelanything.library.tmpdir}, else {@code
 *       java.io.tmpdir}).
 * </ol>
 *
 * <p>{@code os} is {@code linux}, {@code macos} or {@code windows}; {@code arch} is {@code
 * x86_64} or {@code aarch64}; {@code file} is {@code System.mapLibraryName("labelanything")}.
 */
final class NativeLibrary {
  static final String PATH_PROPERTY = "labelanything.library.path";
  static final String TMPDIR_PROPERTY = "labelanything.library.tmpdir";
  static final String NAME = "labelanything";

  private static Path resolved;

  private NativeLibrary() {}

  /** The library file (resolved once per JVM). */
  static synchronized Path path() {
    if (resolved == null) {
      resolved = resolve(System.getProperty(PATH_PROPERTY),
          System.getProperty("java.library.path"), NativeLibrary::extractBundled);
    }
    return resolved;
  }

  /** {@code liblabelanything.so}, {@code liblabelanything.dylib} or {@code labelanything.dll}. */
  static String fileName() {
    return System.mapLibraryName(NAME);
  }

  /** {@code {os}-{arch}} of the running JVM, e.g. {@code linux-x86_64}. */
  static String platform() {
    return platform(System.getProperty("os.name", ""), System.getProperty("os.arch", ""));
  }

  static String platform(String osName, String osArch) {
    String n = osName.toLowerCase(Locale.ROOT);
    String os = n.startsWith("linux") ? "linux"
        : n.startsWith("mac") || n.startsWith("darwin") ? "macos"
        : n.startsWith("windows") ? "windows"
        : n.replaceAll("[^a-z0-9]", "");
    String a = osArch.toLowerCase(Locale.ROOT);
    String arch = switch (a) {
      case "amd64", "x86_64", "x86-64", "x64" -> "x86_64";
      case "aarch64", "arm64" -> "aarch64";
      default -> a.replaceAll("[^a-z0-9_]", "");
    };
    return os + "-" + arch;
  }

  /** The bundled resource name for this platform. */
  static String resourceName() {
    return "native/" + platform() + "/" + fileName();
  }

  /**
   * Resolution order (see the class comment). {@code bundled} receives the resource name
   * and returns the extracted file, or null when the JAR has none for this platform.
   */
  static Path resolve(String property, String javaLibraryPath, Function<String, Path> bundled) {
    List<String> tried = new ArrayList<>();
    if (property != null && !property.isBlank()) {
      Path p = Paths.get(property.trim());
      Path file = Files.isDirectory(p) ? p.resolve(fileName()) : p;
      if (Files.isRegularFile(file)) {
        return file.toAbsolutePath();
      }
      throw new LabelAnythingException(
          "-D" + PATH_PROPERTY + "=" + property + ": no " + fileName() + " there", null);
    }
    if (javaLibraryPath != null) {
      for (String dir : javaLibraryPath.split(File.pathSeparator)) {
        if (dir.isBlank()) {
          continue;
        }
        Path file = Paths.get(dir).resolve(fileName());
        if (Files.isRegularFile(file)) {
          return file.toAbsolutePath();
        }
      }
      tried.add("java.library.path");
    }
    String resource = resourceName();
    Path extracted = bundled.apply(resource);
    if (extracted != null) {
      return extracted;
    }
    tried.add("resource " + resource);
    throw new LabelAnythingException("native library " + fileName() + " not found (tried -D"
        + PATH_PROPERTY + ", " + String.join(", ", tried) + "); build it with `cargo build"
        + " --release -p label-anything-capi --features jni` and pass -D" + PATH_PROPERTY
        + "=rust/target/release", null);
  }

  /** Extract the bundled library to a temporary file (null if the JAR has none). */
  static Path extractBundled(String resource) {
    ClassLoader cl = NativeLibrary.class.getClassLoader();
    try (InputStream in = cl == null
        ? ClassLoader.getSystemResourceAsStream(resource)
        : cl.getResourceAsStream(resource)) {
      if (in == null) {
        return null;
      }
      String tmp = System.getProperty(TMPDIR_PROPERTY);
      Path dir = tmp != null && !tmp.isBlank()
          ? Files.createDirectories(Paths.get(tmp))
          : Paths.get(System.getProperty("java.io.tmpdir"));
      Path sub = Files.createTempDirectory(dir, "labelanything-");
      sub.toFile().deleteOnExit(); // registered first: deleted last, after the file
      Path file = sub.resolve(fileName());
      Files.copy(in, file, StandardCopyOption.REPLACE_EXISTING);
      file.toFile().deleteOnExit();
      return file.toAbsolutePath();
    } catch (IOException e) {
      throw new LabelAnythingException("cannot extract " + resource + ": " + e.getMessage(), e);
    }
  }
}
