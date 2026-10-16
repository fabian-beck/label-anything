package io.github.fabianbeck.labelanything;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Resolution order of the native library (no library is loaded). */
class NativeLibraryTest {
  @TempDir Path tmp;

  private Path fakeLibrary(String dir) throws IOException {
    Path d = Files.createDirectories(tmp.resolve(dir));
    return Files.writeString(d.resolve(NativeLibrary.fileName()), "not really a library");
  }

  @Test
  void systemPropertyFileOrDirectoryWins() throws IOException {
    Path lib = fakeLibrary("prop");
    Path other = fakeLibrary("jlp");
    assertEquals(lib, NativeLibrary.resolve(lib.toString(), other.getParent().toString(),
        r -> { throw new AssertionError("bundled must not be used"); }));
    assertEquals(lib, NativeLibrary.resolve(lib.getParent().toString(), null, r -> null));
    LabelAnythingException e = assertThrows(LabelAnythingException.class,
        () -> NativeLibrary.resolve(tmp.resolve("missing").toString(), null, r -> null));
    assertTrue(e.getMessage().contains("labelanything.library.path"), e.getMessage());
  }

  @Test
  void thenJavaLibraryPath() throws IOException {
    Path lib = fakeLibrary("b");
    String jlp = tmp.resolve("a") + File.pathSeparator + lib.getParent() + File.pathSeparator;
    assertEquals(lib, NativeLibrary.resolve(null, jlp,
        r -> { throw new AssertionError("bundled must not be used"); }));
  }

  @Test
  void thenBundledResource() throws IOException {
    Path extracted = fakeLibrary("extracted");
    List<String> asked = new ArrayList<>();
    assertEquals(extracted, NativeLibrary.resolve("", tmp.resolve("empty").toString(), r -> {
      asked.add(r);
      return extracted;
    }));
    assertEquals(List.of("native/" + NativeLibrary.platform() + "/" + NativeLibrary.fileName()),
        asked);
    LabelAnythingException e = assertThrows(LabelAnythingException.class,
        () -> NativeLibrary.resolve(null, null, r -> null));
    assertTrue(e.getMessage().contains("cargo build"), e.getMessage());
  }

  @Test
  void platformNames() {
    assertEquals("linux-x86_64", NativeLibrary.platform("Linux", "amd64"));
    assertEquals("linux-aarch64", NativeLibrary.platform("Linux", "aarch64"));
    assertEquals("macos-aarch64", NativeLibrary.platform("Mac OS X", "aarch64"));
    assertEquals("macos-x86_64", NativeLibrary.platform("Mac OS X", "x86_64"));
    assertEquals("windows-x86_64", NativeLibrary.platform("Windows 11", "amd64"));
  }

  @Test
  void bundledExtractionReturnsNullWithoutResource() {
    assertEquals(null, NativeLibrary.extractBundled("native/no-such-platform/libnothing.so"));
  }
}
