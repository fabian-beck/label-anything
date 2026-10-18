// Getting started with Go (docs/getting-started/c-go.md): a small typed wrapper around the
// C ABI with cgo.
//
//	cd examples/tutorials/go && go build -o la-basics ./basics
//	LD_LIBRARY_PATH=../../../rust/target/release ./la-basics
package main

// --8<-- [start:cgo]

/*
#cgo CFLAGS: -I${SRCDIR}/../../../../rust/crates/la-capi/include
#cgo LDFLAGS: -L${SRCDIR}/../../../../rust/target/release -llabelanything
#include <stdlib.h>
#include "label_anything.h"
*/
import "C"

// --8<-- [end:cgo]

import (
	"encoding/json"
	"fmt"
	"os"
	"unsafe"
)

// --8<-- [start:wrapper]

// Issue is one validation error ({pointer, code, message}).
type Issue struct {
	Pointer string `json:"pointer"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error is returned for invalid problems (rc = LA_INVALID) and other failures.
type Error struct {
	Code   int
	Issues []Issue
}

func (e *Error) Error() string { return fmt.Sprintf("label-anything (rc=%d): %v", e.Code, e.Issues) }

// Place solves a problem (any JSON-serializable value) and decodes the result into out.
func Place(problem any, out any) error {
	in, err := json.Marshal(problem)
	if err != nil {
		return err
	}
	cs := C.CString(string(in))
	defer C.free(unsafe.Pointer(cs))
	var res *C.char
	rc := C.la_place_json(cs, nil, 0, 0, &res)
	defer C.la_free(res)
	text := []byte(C.GoString(res))
	if rc != C.LA_OK {
		e := &Error{Code: int(rc)}
		_ = json.Unmarshal(text, &e.Issues)
		return e
	}
	return json.Unmarshal(text, out)
}

// --8<-- [end:wrapper]

// --8<-- [start:use]

// Result holds the parts of result.v1 this program reads.
type Result struct {
	Placements []struct {
		ID         string                        `json:"id"`
		Placed     bool                          `json:"placed"`
		Box        *struct{ X, Y, W, H float64 } `json:"box"` // nil when omitted
		AnchorSide string                        `json:"anchor_side"`
		Reason     string                        `json:"reason"`
	} `json:"placements"`
	Stats struct {
		Placed         int `json:"placed"`
		Total          int `json:"total"`
		HardViolations int `json:"hard_violations"`
	} `json:"stats"`
}

func main() {
	item := func(id string, x, y float64, text string) map[string]any {
		return map[string]any{"id": id, "anchor": map[string]any{"type": "point", "x": x, "y": y},
			"label": map[string]any{"type": "text", "text": text}}
	}
	problem := map[string]any{
		"canvas": map[string]any{"width": 400, "height": 300},
		"items":  []any{item("a", 120, 80, "Alpha"), item("b", 126, 84, "Beta"), item("c", 300, 200, "Gamma")},
	}
	var res Result
	if err := Place(problem, &res); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, p := range res.Placements {
		if p.Placed {
			fmt.Println(p.ID, p.AnchorSide, *p.Box)
		} else {
			fmt.Println(p.ID, "omitted:", p.Reason) // no box
		}
	}
	// --8<-- [end:use]
	if res.Stats.Placed != 3 || res.Stats.HardViolations != 0 {
		panic(fmt.Sprintf("unexpected stats %+v", res.Stats))
	}
	// Omitted labels have no box: on this canvas at most one label fits.
	var crowded Result
	if err := Place(map[string]any{
		"canvas": map[string]any{"width": 40, "height": 24},
		"items":  []any{item("a", 20, 12, "Alpha"), item("b", 21, 12, "Beta"), item("c", 19, 13, "Gamma"), item("d", 20, 11, "Delta")},
	}, &crowded); err != nil || crowded.Stats.Placed == crowded.Stats.Total {
		panic(fmt.Sprintf("expected omissions, got %v %+v", err, crowded.Stats))
	}
	for _, p := range crowded.Placements {
		if p.Placed != (p.Box != nil) || !p.Placed && p.Reason == "" {
			panic(fmt.Sprintf("placement %+v", p))
		}
	}

	// --8<-- [start:invalid]
	err := Place(map[string]any{"items": []any{map[string]any{"anchor": map[string]any{"type": "point", "x": 1}}}}, &res)
	fmt.Println(err) // label-anything (rc=1): [{/items/0/anchor/y required ...} {/items/0/label required ...}]
	// --8<-- [end:invalid]
	if e, ok := err.(*Error); !ok || e.Code != 1 || len(e.Issues) == 0 {
		panic(fmt.Sprintf("expected an invalid problem, got %v", err))
	}
	fmt.Println("ok")
}
