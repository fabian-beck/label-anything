/* Label Anything from C: place two labels and print the result.
 *
 *   cargo build --release -p label-anything-capi --manifest-path rust/Cargo.toml
 *   cc examples/c/main.c -Irust/crates/la-capi/include -Lrust/target/release -llabelanything -o /tmp/la-c
 *   LD_LIBRARY_PATH=rust/target/release /tmp/la-c
 */
#include <stdio.h>
#include <stdlib.h>
#include "label_anything.h"

int main(void) {
    const char *problem =
        "{\"canvas\":{\"width\":400,\"height\":300},\"items\":["
        "{\"id\":\"a\",\"anchor\":{\"type\":\"point\",\"x\":120,\"y\":80},\"label\":{\"type\":\"text\",\"text\":\"Alpha\"}},"
        "{\"id\":\"b\",\"anchor\":{\"type\":\"point\",\"x\":126,\"y\":84},\"label\":{\"type\":\"text\",\"text\":\"Beta\"}}]}";
    /* a 4x4 RGBA background, black pixel in the corner (zero-copy entry point) */
    uint8_t rgba[4 * 4 * 4];
    for (int i = 0; i < 4 * 4 * 4; i++) rgba[i] = 255;
    rgba[0] = rgba[1] = rgba[2] = 0;
    char *result = NULL;
    int rc = la_place_json(problem, NULL, 0, 0, &result);
    printf("label-anything %s, rc=%d\n%s\n", la_version(), rc, result);
    la_free(result);
    char *report = NULL;
    rc = la_validate_json("{\"items\":[{\"anchor\":{\"type\":\"point\",\"x\":1}}]}", &report);
    printf("validate rc=%d %s\n", rc, report);
    la_free(report);
    (void)rgba;
    return 0;
}
