/* Label your outliers in five lines (docs/tutorials/outliers.md), in C.
 *
 *   cc examples/tutorials/c/outliers.c -Irust/crates/la-capi/include \
 *      -Lrust/target/release -llabelanything -o outliers
 *   cd <a copy of examples/tutorials/data> && LD_LIBRARY_PATH=.../rust/target/release ./outliers
 *
 * Prints the result JSON (result.v1) on stdout.
 */
#include <stdio.h>
#include <stdlib.h>
#include "label_anything.h"

/* The whole file as a NUL-terminated string (NULL on failure). */
static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    rewind(f);
    char *s = malloc((size_t)n + 1);
    if (s && fread(s, 1, (size_t)n, f) == (size_t)n) s[n] = '\0'; else { free(s); s = NULL; }
    fclose(f);
    return s;
}

int main(void) {
    /* --8<-- [start:five] */
    char *problem = read_file("outliers.json");            /* problem.v1 JSON text */
    char *result = NULL;
    int rc = la_place_json(problem, NULL, 0, 0, &result);  /* LA_OK, LA_INVALID or LA_ERROR */
    puts(result);                                          /* result.v1 JSON, or the errors */
    la_free(result);
    /* --8<-- [end:five] */
    free(problem);
    return rc == LA_OK ? 0 : 1;
}
