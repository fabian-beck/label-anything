# Scenario 01 — data license

| Data | Source (pinned) | License | Attribution |
|---|---|---|---|
| Java sources of `ReactAndroid/src/main/java` | npm `react-native@0.63.5` tarball, SHA-256 `4100debc…fd631eee` | MIT | React Native, Copyright (c) Facebook, Inc. and its affiliates. |

The sources are downloaded by `fetch.py` and never committed. `build.py` only derives
class names and metric values (CBO, RFC, WMC, LOC, …) from them; the generated problems
contain no source code. Attribution when publishing results: *"Class metrics computed
from React Native 0.63.5 (MIT License, © Facebook, Inc. and its affiliates)."*

`CkLite.java` is part of this repository (MIT, see `LICENSE` at the repository root). It
reimplements the metric definitions of the CK tool (M. Aniche, Apache-2.0,
<https://github.com/mauricioaniche/ck>); no CK code is copied.
