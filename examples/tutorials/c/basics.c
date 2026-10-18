/* Getting started with C (docs/getting-started/c-go.md): place, validate, raster pixels
 * by pointer and the debug overlay through the C ABI (label_anything.h).
 *
 *   cc -std=c99 examples/tutorials/c/basics.c -Irust/crates/la-capi/include \
 *      -Lrust/target/release -llabelanything -o basics
 *   LD_LIBRARY_PATH=rust/target/release ./basics
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "label_anything.h"

#define CHECK(cond) do { if (!(cond)) { fprintf(stderr, "check failed: %s\n", #cond); return 1; } } while (0)

int main(void) {
    /* --8<-- [start:place] */
    const char *problem =
        "{\"canvas\": {\"width\": 400, \"height\": 300}, \"items\": ["
        "{\"id\": \"a\", \"anchor\": {\"type\": \"point\", \"x\": 120, \"y\": 80}, \"label\": {\"type\": \"text\", \"text\": \"Alpha\"}},"
        "{\"id\": \"b\", \"anchor\": {\"type\": \"point\", \"x\": 126, \"y\": 84}, \"label\": {\"type\": \"text\", \"text\": \"Beta\"}}]}";
    char *result = NULL;
    int rc = la_place_json(problem, NULL, 0, 0, &result);
    if (rc == LA_OK) {
        printf("%s\n", result);                 /* result.v1 JSON */
    } else {
        fprintf(stderr, "rc=%d: %s\n", rc, result);   /* JSON array of {pointer, code, message} */
    }
    /* --8<-- [end:place] */
    CHECK(rc == LA_OK && strstr(result, "\"hard_violations\":0") != NULL);

    /* --8<-- [start:render] */
    char *svg = NULL;
    if (la_render_svg(problem, result, &svg) == LA_OK) {
        printf("overlay: %zu bytes of SVG\n", strlen(svg));
    }
    la_free(svg);
    la_free(result);                            /* every returned string, exactly once */
    /* --8<-- [end:render] */

    /* --8<-- [start:validate] */
    char *report = NULL;
    rc = la_validate_json("{\"items\": [{\"anchor\": {\"type\": \"point\", \"x\": 1}, "
                          "\"label\": {\"type\": \"text\", \"text\": \"A\"}}]}", &report);
    printf("rc=%d %s\n", rc, report);           /* rc=1 {"valid":false,"errors":[{"pointer":"/items/0/anchor/y",... */
    la_free(report);
    /* --8<-- [end:validate] */
    CHECK(rc == LA_INVALID);

    /* --8<-- [start:pixels] */
    enum { W = 400, H = 300 };
    uint8_t *rgba = malloc(W * H * 4);          /* row-major RGBA8, straight alpha */
    for (int i = 0; i < W * H; i++) {
        int x = i % W;
        uint8_t v = (x >= 180 && x < 220) ? 30 : 250;   /* a dark vertical band */
        rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = v;
        rgba[4 * i + 3] = 255;
    }
    const char *over_pixels =
        "{\"obstacles\": {\"raster\": {\"source\": \"host\", \"mode\": \"ink\"}},"   /* options for the pixels; source not read */
        " \"avoid\": {\"label\": {\"ink\": \"hard\"}}, \"items\": [{\"id\": \"p\","
        " \"anchor\": {\"type\": \"point\", \"x\": 200, \"y\": 150}, \"label\": {\"type\": \"text\", \"text\": \"Next to the band\"}}]}";
    rc = la_place_json(over_pixels, rgba, W, H, &result);   /* by pointer: no PNG, no base64 */
    free(rgba);                                 /* the library keeps no pointer to it */
    /* --8<-- [end:pixels] */
    CHECK(rc == LA_OK && strstr(result, "\"placed\":true") != NULL);
    printf("%s\nlabel-anything %s: ok\n", result, la_version());
    la_free(result);
    return 0;
}
