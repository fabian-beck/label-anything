// Label your outliers in five lines (docs/tutorials/outliers.md), in Go through the C ABI.
//
//	cd examples/tutorials/go && go build -o /tmp/outliers ./outliers
//	cd <a copy of examples/tutorials/data> && LD_LIBRARY_PATH=.../rust/target/release /tmp/outliers
//
// Prints the result JSON (result.v1) on stdout.
package main

/*
#cgo CFLAGS: -I${SRCDIR}/../../../../rust/crates/la-capi/include
#cgo LDFLAGS: -L${SRCDIR}/../../../../rust/target/release -llabelanything
#include <stdlib.h>
#include "label_anything.h"
*/
import "C"

import (
	"fmt"
	"os"
	"unsafe"
)

func main() {
	// --8<-- [start:five]
	problem, _ := os.ReadFile("outliers.json") // problem.v1 JSON
	cs := C.CString(string(problem))
	var result *C.char
	rc := C.la_place_json(cs, nil, 0, 0, &result) // LA_OK, LA_INVALID or LA_ERROR
	fmt.Println(C.GoString(result))               // result.v1 JSON, or the errors
	C.la_free(result)
	// --8<-- [end:five]
	C.free(unsafe.Pointer(cs))
	if rc != C.LA_OK {
		os.Exit(1)
	}
}
