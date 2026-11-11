# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, through
[GitHub's private vulnerability reporting](https://github.com/fabian-beck/label-anything/security/advisories/new)
(the repository's *Security* tab → *Report a vulnerability*), not in a public issue. Say
which package and version you used, and add the input that shows the problem if you can.
Label Anything is experimental software maintained in spare time: expect an answer within
two weeks.

Fixes go into the latest release; older versions get none while the version is 0.x.

## What counts

The engine reads four kinds of input that may come from someone else: the problem (JSON),
SVG backgrounds, raster images and font files. For all of them, in every package:

* memory unsafety, in the C ABI and the JNI entry points above all, is a vulnerability;
* a crash (a panic, an uncaught exception that is not the documented error) and time or
  memory far beyond what the size of the input explains are errors we want to hear about,
  and vulnerabilities where they take down a service.

The engine's crates (`label-anything` and its parts `-core`, `-expr`, `-text`, `-svg`,
`-raster`, `-render`) forbid `unsafe` code, the parsers are fuzzed weekly (`rust/fuzz`),
and the solver has a time budget and a wall-clock guard.

## What a host has to do

**A problem can name files.** `obstacles.svg.path`, a raster `source` and a font `file`
are paths the engine reads. Solving a problem from an untrusted source therefore lets its
author probe which files exist and are readable, and have them parsed. Before you solve
such problems:

* Rust: solve with a `NativeEnv` whose `allow_files` is `false`;
* JavaScript (`@label-anything/core`, `@label-anything/wasm`): files are read only
  through the `readFile` option; leave it out;
* the HTTP server (`label-anything serve`) reads files only while it listens on a
  loopback address, or with `--allow-files`;
* Python, Java and the C ABI always read the files a problem names: reject problems that
  name files (or validate the paths) before you pass them on.

**The HTTP server has no authentication** and allows requests from any origin. It is made
for the local machine and for trusted networks. Put a reverse proxy in front of it for
anything else, and limit the size and rate of requests there.

**Callbacks run your code.** Priority expressions (`priority.terms[].expr`) are a small,
side-effect-free language and safe to take from anyone; the `priority`, `cost` and
`measure` callbacks of the language bindings are ordinary functions of your program.
