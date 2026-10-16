// Label Anything from Go via cgo.
//
//	cargo build --release -p label-anything-capi --manifest-path rust/Cargo.toml
//	cd examples/go && LD_LIBRARY_PATH=../../rust/target/release go run .
//
// The cgo directives below point at the header and the library inside this repository;
// for an installed library, replace them with your include and library paths.
package main

/*
#cgo CFLAGS: -I${SRCDIR}/../../rust/crates/la-capi/include
#cgo LDFLAGS: -L${SRCDIR}/../../rust/target/release -llabelanything
#include <stdlib.h>
#include "label_anything.h"
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"unsafe"
)

// Place solves a problem (any JSON-serializable value) and decodes the result.
func Place(problem any) (map[string]any, error) {
	in, err := json.Marshal(problem)
	if err != nil {
		return nil, err
	}
	cs := C.CString(string(in))
	defer C.free(unsafe.Pointer(cs))
	var out *C.char
	rc := C.la_place_json(cs, nil, 0, 0, &out)
	defer C.la_free(out)
	text := C.GoString(out)
	if rc != C.LA_OK {
		return nil, fmt.Errorf("label-anything (rc=%d): %s", int(rc), text)
	}
	var res map[string]any
	return res, json.Unmarshal([]byte(text), &res)
}

func main() {
	problem := map[string]any{
		"canvas": map[string]any{"width": 400, "height": 300},
		"items": []any{
			map[string]any{"id": "a", "anchor": map[string]any{"type": "point", "x": 120, "y": 80}, "label": map[string]any{"type": "text", "text": "Alpha"}},
			map[string]any{"id": "b", "anchor": map[string]any{"type": "point", "x": 126, "y": 84}, "label": map[string]any{"type": "text", "text": "Beta"}},
		},
	}
	res, err := Place(problem)
	if err != nil {
		panic(err)
	}
	for _, p := range res["placements"].([]any) {
		pl := p.(map[string]any)
		fmt.Println(pl["id"], pl["placed"], pl["box"], pl["anchor_side"])
	}
	fmt.Println("hard violations:", res["stats"].(map[string]any)["hard_violations"])
}
