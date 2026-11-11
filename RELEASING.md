# Releasing

One version covers every package: the crates, the npm packages, the two Python packages
and the JAR. A release is a tag `vX.Y.Z` on `main` whose CI run is green.

## Before the tag

1. **The benchmark.** Run the full suite with every implementation and baseline against
   the results of the previous release, and keep its `results.json` with the release
   (`bench/README.md`, *Release gates*). The gates must pass: no hard violations, no
   metric more than 2 % worse unless a decision record accepts it, the performance targets
   met.
2. **The version.** `node tools/version.mjs --set X.Y.Z` writes it into every manifest,
   lock file, constant and command that names it, and today's date into `CITATION.cff`;
   `--check` (also in CI) fails when two places disagree.
3. **The changelog.** Rename *Unreleased* in `CHANGELOG.md` to the version and its date,
   and open a new *Unreleased* section.
4. **The names.** Before the first release, check again that `label-anything` is free on
   crates.io and PyPI, the scope `@label-anything` on npm and the namespace
   `io.github.fabian-beck` on Maven Central (ADR project/name).

CI builds what would be published on every change and checks its contents, so a commit
that is green can be released: the crates (`cargo package`, each built from the files it
would publish), the npm tarballs (`tools/check-packages.mjs`), the wheel and the source
distributions (`tools/check-wheels.py`).

## The tag

```sh
git tag -a vX.Y.Z -m "Label Anything X.Y.Z" && git push origin vX.Y.Z
```

The CI run of the tag runs the full benchmark and, with the baselines, the release gates;
when it succeeds, the Pages workflow publishes the documentation, the playground and the
benchmark report of the tag.

## Publishing

Nothing is published automatically yet. From the tagged commit, in this order (a package
needs the ones before it):

```sh
# crates.io: the parts, then the facade, the CLI and the C ABI
cd rust && cargo publish --workspace --exclude label-anything-py --exclude label-anything-wasm

# npm: `prepack` builds each package; the WebAssembly package needs its toolchain
# (rustup target add wasm32-unknown-unknown, wasm-bindgen-cli at the version of Cargo.lock)
npm ci
for p in text svg raster core cli wasm extras; do npm publish -w @label-anything/$p; done

# PyPI: the engine, then the plotting helpers (each needs the other at the same version)
maturin sdist -m rust/crates/la-py/Cargo.toml --out dist
python -m build bindings/python-extras --outdir dist
twine upload dist/*
```

Then create the GitHub release of the tag with the changelog section as its text.

## Not automated yet

* **Wheels for every platform.** The commands above upload the source distribution of
  `label-anything`, which needs a Rust toolchain to install. A release needs wheels for
  Linux (manylinux and musllinux, x86-64 and aarch64), macOS (x86-64 and arm64) and
  Windows, built in a workflow (`PyO3/maturin-action`; the wheel is abi3, so one per
  platform serves every Python ≥ 3.9) and uploaded with PyPI's trusted publishing.
* **The JAR.** Maven Central asks for a sources JAR, a Javadoc JAR and signatures, which
  `bindings/java/pom.xml` does not produce yet, and the JAR bundles the native library of
  the machine that builds it. A release needs the library built for every platform and
  collected into one JAR.
* **Binaries of the command line** and of `liblabelanything` attached to the GitHub
  release, for people without a Rust toolchain.
