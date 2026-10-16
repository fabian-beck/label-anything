/*
 * Label Anything — C ABI (label placement engine).
 * MIT License. https://github.com/fabian-beck/label-anything
 *
 * All strings are UTF-8 and NUL-terminated. Every string returned through an out
 * parameter is owned by the library and must be released with la_free().
 *
 * Return codes: LA_OK (0) success; LA_INVALID (1) the problem is invalid — *result holds a
 * JSON array of {pointer, code, message}; LA_ERROR (2) other failure — *result holds a
 * JSON array with one error object.
 */
#ifndef LABEL_ANYTHING_H
#define LABEL_ANYTHING_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LA_OK 0
#define LA_INVALID 1
#define LA_ERROR 2

/* Solve `problem` (JSON, problem.v1). If `rgba` is not NULL it is used as the raster
 * background (row-major RGBA8, `width` x `height`, straight alpha), replacing
 * obstacles.raster sources; the problem's first raster object (if any) supplies the
 * options (mode, class, scale, ...). The result JSON (result.v1) is written to *result. */
int32_t la_place_json(const char *problem, const uint8_t *rgba, uint32_t width, uint32_t height, char **result);

/* Validate `problem`; writes the report JSON ({valid, errors, warnings}) to *report.
 * Returns LA_OK when valid, LA_INVALID otherwise. */
int32_t la_validate_json(const char *problem, char **report);

/* Render the debug SVG overlay of a problem and a result. */
int32_t la_render_svg(const char *problem, const char *result, char **svg);

/* Library version, e.g. "0.1.0" (static string, do not free). */
const char *la_version(void);

/* Release a string returned by this library. Passing NULL is a no-op. */
void la_free(char *s);

#ifdef __cplusplus
}
#endif

#endif /* LABEL_ANYTHING_H */
