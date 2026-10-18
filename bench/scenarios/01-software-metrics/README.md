# 01 — Software metrics outliers

**What.** A scatterplot of class-level metrics of a well-known open-source Java code
base — the Android runtime of React Native 0.63.5 (`ReactAndroid/src/main/java`, 745
files, 1,206 classes incl. nested and anonymous ones) — with the outliers labeled by
their fully qualified class names.

**Why.** Typical software-visualization task: few labels, but very long ones
(`com.facebook.react.uimanager.NativeViewHierarchyManager`), placed into a dense
point cloud whose points must stay readable; package dots are natural wrap points.

**Metrics.** CK's jar-with-dependencies is not on Maven Central and its Eclipse-JDT
dependency closure could not be fetched reliably (Maven Central is rate-limited here), so
`CkLite.java` computes CK's definitions on the JDK's own javac syntax tree (no type
attribution, documented approximation; see the header of `CkLite.java`): CBO (distinct
referenced types, `java.*`/`javax.*` ignored), RFC (distinct invocations by receiver,
name and arity), WMC (Σ 1 + branches), LOC, NOM, NOF. Needs a JDK ≥ 11 (`java` on PATH).

**Configs** (canvas 1000 × 720 px, preset `scatter`, font 10 px, priority = outlierness, font classes: the top 5 % at 1.25 ×, the rest at 0.9 ×):

| config | labels | background | notes |
|---|---|---|---|
| `cbo-rfc-10-none` (quick) | 10 | none | other classes as soft `points` (r 2.5) |
| `cbo-rfc-30-vector` | 30 | vector layers | axes (hard), grid (0.2), tick labels (`text`, hard) |
| `cbo-rfc-100-svg` | 100 | SVG | names without the shared prefix `com.facebook.react.` (or `com.facebook.`) wrap (`max_width` 16 em, 3 lines) |
| `wmc-loc-30-raster` | 30 | PNG, raster mode `ink` | WMC vs LOC; names as in `cbo-rfc-100-svg` |

**Rendering recipe.** x = log10(1 + CBO), y = log10(1 + RFC) (or WMC/LOC), each value
jittered deterministically by at most ±0.3 metric units (SHA-256 of the class name) so
identical integer pairs do not coincide; plot area (78, 24)–(976, 658) px; points r 2.5
(`#7f8c99`, opacity 0.75); outlier marks r 3. Outlierness = mean distance to the 5
nearest classes in canvas px; the top N are labeled (ties by name).
