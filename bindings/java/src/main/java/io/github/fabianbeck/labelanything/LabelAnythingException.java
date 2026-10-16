package io.github.fabianbeck.labelanything;

import java.util.List;
import java.util.stream.Collectors;

/**
 * A failed call: an invalid problem ({@link #INVALID}, with one {@link Issue} per error and
 * its JSON pointer) or another failure ({@link #ERROR}: native library not found, internal
 * error).
 */
public class LabelAnythingException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  /** The problem is invalid ({@code LA_INVALID}). */
  public static final int INVALID = 1;

  /** Any other failure ({@code LA_ERROR}). */
  public static final int ERROR = 2;

  private final int code;
  private final transient List<Issue> issues;

  /** An exception with the given return code and issues. */
  public LabelAnythingException(int code, List<Issue> issues) {
    super(message(code, issues));
    this.code = code;
    this.issues = List.copyOf(issues);
  }

  /** A failure outside the engine (e.g. loading the native library). */
  public LabelAnythingException(String message, Throwable cause) {
    super(message, cause);
    this.code = ERROR;
    this.issues = List.of(new Issue("", "native", message));
  }

  private static String message(int code, List<Issue> issues) {
    String head = code == INVALID ? "invalid problem" : "label placement failed";
    if (issues.isEmpty()) {
      return head;
    }
    String list = issues.stream().limit(5).map(Issue::toString).collect(Collectors.joining("; "));
    return head + ": " + list + (issues.size() > 5 ? "; ... (" + issues.size() + " issues)" : "");
  }

  /** {@link #INVALID} or {@link #ERROR}. */
  public int code() {
    return code;
  }

  /** The errors, each with a JSON pointer into the problem, a code and a message. */
  public List<Issue> issues() {
    return issues;
  }

  /** Whether the problem was invalid (as opposed to another failure). */
  public boolean isInvalidProblem() {
    return code == INVALID;
  }
}
