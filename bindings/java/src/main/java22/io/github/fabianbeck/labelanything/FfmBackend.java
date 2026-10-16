package io.github.fabianbeck.labelanything;

import static java.lang.foreign.ValueLayout.ADDRESS;
import static java.lang.foreign.ValueLayout.JAVA_BYTE;
import static java.lang.foreign.ValueLayout.JAVA_INT;

import java.lang.foreign.Arena;
import java.lang.foreign.FunctionDescriptor;
import java.lang.foreign.Linker;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.SymbolLookup;
import java.lang.invoke.MethodHandle;
import java.nio.file.Path;

/**
 * The FFM path (Java 22+): the C ABI of {@code liblabelanything} ({@code
 * label_anything.h}) called through {@link Linker#nativeLinker()}. Pixels in a direct
 * buffer are passed to {@code la_place_json} in place; pixels in a heap array are copied
 * once into native memory.
 */
@SuppressWarnings("restricted") // the purpose of this class
final class FfmBackend implements NativeBackend {
  private final MethodHandle placeJson;
  private final MethodHandle validateJson;
  private final MethodHandle renderSvg;
  private final MethodHandle version;
  private final MethodHandle free;

  FfmBackend(Path library) {
    Linker linker = Linker.nativeLinker();
    SymbolLookup lib = SymbolLookup.libraryLookup(library, Arena.global());
    // int32_t la_place_json(const char*, const uint8_t*, uint32_t, uint32_t, char**)
    placeJson = linker.downcallHandle(find(lib, "la_place_json"),
        FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS, JAVA_INT, JAVA_INT, ADDRESS));
    // int32_t la_validate_json(const char*, char**)
    validateJson = linker.downcallHandle(find(lib, "la_validate_json"),
        FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS));
    // int32_t la_render_svg(const char*, const char*, char**)
    renderSvg = linker.downcallHandle(find(lib, "la_render_svg"),
        FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS, ADDRESS));
    // const char* la_version(void)
    version = linker.downcallHandle(find(lib, "la_version"), FunctionDescriptor.of(ADDRESS));
    // void la_free(char*)
    free = linker.downcallHandle(find(lib, "la_free"), FunctionDescriptor.ofVoid(ADDRESS));
  }

  private static MemorySegment find(SymbolLookup lib, String name) {
    return lib.find(name).orElseThrow(
        () -> new LabelAnythingException("symbol " + name + " missing in the native library", null));
  }

  @Override
  public String name() {
    return "ffm";
  }

  @Override
  public String version() {
    try {
      MemorySegment s = (MemorySegment) version.invokeExact();
      return s.reinterpret(Long.MAX_VALUE).getString(0);
    } catch (Throwable t) {
      throw rethrow(t);
    }
  }

  /** Read and free a string returned through a {@code char**}. */
  private String take(MemorySegment out) throws Throwable {
    MemorySegment s = out.get(ADDRESS, 0);
    if (s.equals(MemorySegment.NULL)) {
      return "";
    }
    try {
      return s.reinterpret(Long.MAX_VALUE).getString(0);
    } finally {
      free.invokeExact(s);
    }
  }

  @Override
  public Reply place(String problem, Pixels px) {
    try (Arena arena = Arena.ofConfined()) {
      MemorySegment p = arena.allocateFrom(problem);
      MemorySegment rgba = MemorySegment.NULL;
      int w = 0;
      int h = 0;
      if (px != null) {
        w = px.width;
        h = px.height;
        if (px.direct != null) {
          rgba = MemorySegment.ofBuffer(px.direct); // zero-copy: the buffer's own memory
        } else {
          rgba = arena.allocate(px.length());
          MemorySegment.copy(px.array, px.offset, rgba, JAVA_BYTE, 0, px.length());
        }
      }
      MemorySegment out = arena.allocate(ADDRESS);
      int code = (int) placeJson.invokeExact(p, rgba, w, h, out);
      return new Reply(code, take(out));
    } catch (Throwable t) {
      throw rethrow(t);
    }
  }

  @Override
  public Reply validate(String problem) {
    try (Arena arena = Arena.ofConfined()) {
      MemorySegment out = arena.allocate(ADDRESS);
      int code = (int) validateJson.invokeExact(arena.allocateFrom(problem), out);
      return new Reply(code, take(out));
    } catch (Throwable t) {
      throw rethrow(t);
    }
  }

  @Override
  public Reply renderSvg(String problem, String result) {
    try (Arena arena = Arena.ofConfined()) {
      MemorySegment out = arena.allocate(ADDRESS);
      int code = (int) renderSvg.invokeExact(
          arena.allocateFrom(problem), arena.allocateFrom(result), out);
      return new Reply(code, take(out));
    } catch (Throwable t) {
      throw rethrow(t);
    }
  }

  private static RuntimeException rethrow(Throwable t) {
    if (t instanceof RuntimeException r) {
      return r;
    }
    if (t instanceof Error e) {
      throw e;
    }
    return new LabelAnythingException("native call failed: " + t, t);
  }
}
