package io.github.fabianbeck.labelanything;

import java.nio.file.Path;
import java.util.Map;

/**
 * Font settings (problem {@code defaults.font} or per label). Unset fields inherit: label
 * font ← {@code defaults.font} ← built-in defaults (bundled Noto Sans, 12 px, weight 400).
 *
 * <pre>{@code Font.of("default").size(14).bold().lineHeight(1.3)}</pre>
 */
public final class Font extends Spec {
  private Font(Map<String, Object> json) {
    super(json);
  }

  /** No settings: everything is inherited. */
  public static Font defaults() {
    return new Font(Map.of());
  }

  /** A font family; {@code "default"} is the bundled Noto Sans. */
  public static Font of(String family) {
    return defaults().family(family);
  }

  /** Only a size in px. */
  public static Font ofSize(double size) {
    return defaults().size(size);
  }

  /** A TTF/OTF/WOFF2 font file (read by the native library). */
  public static Font fromFile(Path file) {
    return defaults().file(file);
  }

  private Font with(String key, Object value) {
    return new Font(Spec.with(json, key, value));
  }

  /** Font family; {@code "default"} selects the bundled Noto Sans. */
  public Font family(String family) {
    return with("family", family);
  }

  /** Font size in px (&gt; 0). */
  public Font size(double size) {
    return with("size", size);
  }

  /** Weight 1–1000; the nearest available weight is used (bundled: 400 and 700). */
  public Font weight(int weight) {
    return with("weight", weight);
  }

  /** Bold ({@code "bold"}, i.e. weight 700). */
  public Font bold() {
    return with("weight", "bold");
  }

  /** Italic style (the bundled font falls back to upright). */
  public Font italic() {
    return with("style", "italic");
  }

  /** Line pitch of wrapped text as a multiple of the size (default 1.2). */
  public Font lineHeight(double lineHeight) {
    return with("line_height", lineHeight);
  }

  /** A font file on disk (absolute path is sent). */
  public Font file(Path file) {
    return with("file", file);
  }

  /** A font as a {@code data:} URL or a file path string. */
  public Font file(String dataUrlOrPath) {
    return with("file", dataUrlOrPath);
  }
}
