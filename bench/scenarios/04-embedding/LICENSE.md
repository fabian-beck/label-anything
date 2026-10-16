# Scenario 04 — data license

| Data | Source (pinned) | License | Attribution |
|---|---|---|---|
| WordNet 3.0 (`wordnet/data.noun`, glosses and lemma names) | `nltk/nltk_data@550b6625…` `packages/corpora/wordnet.zip`, SHA-256 `cbda5ea6…2646ab59` | WordNet 3.0 license (permissive, BSD-like) | Princeton University "About WordNet." WordNet. Princeton University. 2010. |

WordNet 3.0 license (required notice): *"WordNet 3.0 Copyright 2006 by Princeton
University. All rights reserved. THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND
PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED. … The
name of Princeton University or Princeton may not be used in advertising or publicity
pertaining to distribution of the software and/or database."* The full text is in
`wordnet/LICENSE` inside the downloaded archive.

The archive is downloaded by `fetch.py` and never committed. The lexicographer-file
descriptions used in topic names come from WordNet's documentation (lexnames(5WN)).
