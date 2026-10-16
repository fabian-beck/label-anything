"""Pinned third-party data sources of the benchmark (one table, easy to audit).

Every URL is pinned (git commit hash in raw.githubusercontent.com URLs, exact
package versions on npm / PyPI) and every file has a SHA-256 checksum. Nothing
listed here is committed to the repository: ``bench/scenarios/*/fetch.py``
downloads into ``bench/data/<group>/`` (gitignored).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Source:
    group: str        # directory under bench/data/
    filename: str
    url: str
    sha256: str
    license: str      # SPDX id or short license name
    attribution: str  # required attribution / provenance


GH = "https://raw.githubusercontent.com"
OPENFLIGHTS_COMMIT = "56a3cce4d50309cb79948103a48c7f87d09b3056"
NATURAL_EARTH_COMMIT = "ca96624a56bd078437bca8184e78163e5039ad19"
NFCORE_MODULES_COMMIT = "618f1541382c4ad49eff566dadf13d5ccbd0ebb4"
NLTK_DATA_COMMIT = "550b6625bcef1f2abff2ff770a5a0d272c9c6b2a"
PLANETILER_COMMIT = "7a5e0c59fb1e91e0663bd4c0ec1c61c8a73d1bee"
PYGCN_COMMIT = "1600b5b748b3976413d1e307540ccc62605b4d6d"
TOOLS_IUC_COMMIT = "3b052d865cec46aa69e2b3c12d5f26e61ee7f7cd"

SOURCES: dict[str, Source] = {
    # 01 software metrics: Java sources of React Native's Android runtime (MIT).
    "react-native-0.63.5": Source(
        "react-native", "react-native-0.63.5.tgz",
        "https://registry.npmjs.org/react-native/-/react-native-0.63.5.tgz",
        "4100debcc3f176564cce0b1d883f46b788bf556d5510d14138d214cbfd631eee",
        "MIT", "React Native 0.63.5, Copyright (c) Facebook, Inc. and its affiliates (MIT License)."),
    # 02 volcano: DESeq2 results of nf-core test data SRP254919 (repo MIT; SRA data unrestricted).
    "nfcore-srp254919-deseq2": Source(
        "nfcore-srp254919", "SRP254919.salmon.merged.deseq2.results.tsv",
        f"{GH}/nf-core/test-datasets/{NFCORE_MODULES_COMMIT}/data/genomics/mus_musculus/rnaseq_expression/SRP254919.salmon.merged.deseq2.results.tsv",
        "4e62f2139f7292178d69280dea64c806e043c11fb43cfb3e37d7610776d8beae", "MIT",
        "nf-core/test-datasets (MIT), study SRP254919 (NCBI SRA, no use restrictions)."),
    "nfcore-srp254919-genemeta": Source(
        "nfcore-srp254919", "SRP254919.gene_meta.tsv",
        f"{GH}/nf-core/test-datasets/{NFCORE_MODULES_COMMIT}/data/genomics/mus_musculus/rnaseq_expression/SRP254919.gene_meta.tsv",
        "adc433f06a59c668c03fec522fa3f19890fa8a79ba11a731431044a2b58a06b3", "MIT",
        "nf-core/test-datasets (MIT), study SRP254919 (NCBI SRA, no use restrictions)."),
    # 02 volcano (dense): genome-scale DE table, test data of the Galaxy volcanoplot tool (tools-iuc, MIT).
    "galaxy-volcano-input": Source(
        "galaxy-volcanoplot", "input.tab",
        f"{GH}/galaxyproject/tools-iuc/{TOOLS_IUC_COMMIT}/tools/volcanoplot/test-data/input.tab",
        "d80359b09e3958e93bc15f4846555806941c0bf0de238cc26c8dc153a16156a7", "MIT",
        "galaxyproject/tools-iuc test data (MIT, Copyright (c) 2014 galaxy-iuc); originally the example of the "
        "'Getting Genetics Done' volcano plot tutorial by Stephen Turner."),
    # 03 gapminder, 07 miserables, 09 line charts: vega-datasets (BSD-3-Clause package; per-dataset licenses).
    "vega-datasets-3.2.1": Source(
        "vega-datasets", "vega-datasets-3.2.1.tgz",
        "https://registry.npmjs.org/vega-datasets/-/vega-datasets-3.2.1.tgz",
        "6f72fda460a9863fae5fcb32f85bcd49e1761fdea6dc6cf9f4962472881cc5a3",
        "BSD-3-Clause (package); datasets: see scenario LICENSE.md",
        "vega-datasets 3.2.1 (https://github.com/vega/vega-datasets)."),
    # 04 embedding: WordNet 3.0 as distributed by NLTK (WordNet license, permissive).
    "nltk-wordnet": Source(
        "nltk-wordnet", "wordnet.zip",
        f"{GH}/nltk/nltk_data/{NLTK_DATA_COMMIT}/packages/corpora/wordnet.zip",
        "cbda5ea6eef7f36a97a43d4a75f85e07fccbb4f23657d27b4ccbc93e2646ab59", "WordNet-3.0",
        "Princeton University \"About WordNet.\" WordNet. Princeton University. 2010."),
    # 05/10/11/12 airports: OpenFlights (ODbL 1.0) + Natural Earth (public domain).
    "openflights-airports": Source(
        "openflights", "airports.dat",
        f"{GH}/jpatokal/openflights/{OPENFLIGHTS_COMMIT}/data/airports.dat",
        "9387cdb38df5bd664da823f8ccb69fdd9b33a1888f5b7cca09c34a3cd9ff59f9", "ODbL-1.0",
        "Airport and route data (c) OpenFlights.org contributors, Open Database License (ODbL) 1.0."),
    "openflights-routes": Source(
        "openflights", "routes.dat",
        f"{GH}/jpatokal/openflights/{OPENFLIGHTS_COMMIT}/data/routes.dat",
        "bd373706238134f619c624c606dccc74c05c2582a977c489c81de501735f2390", "ODbL-1.0",
        "Airport and route data (c) OpenFlights.org contributors, Open Database License (ODbL) 1.0."),
    "ne-50m-countries": Source(
        "natural-earth", "ne_50m_admin_0_countries.geojson",
        f"{GH}/nvkelso/natural-earth-vector/{NATURAL_EARTH_COMMIT}/geojson/ne_50m_admin_0_countries.geojson",
        "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb", "public-domain", "Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com."),
    # 06 city POIs: OpenStreetMap extract of Monaco (ODbL 1.0), test resource of planetiler.
    "osm-monaco": Source(
        "osm-monaco", "monaco-latest.osm.pbf",
        f"{GH}/onthegomap/planetiler/{PLANETILER_COMMIT}/planetiler-core/src/test/resources/monaco-latest.osm.pbf",
        "a3fa87c13df03c66107cb314f518672400bb87e539388e390e8aab2c7e88c9be", "ODbL-1.0", "(c) OpenStreetMap contributors, Open Database License (ODbL) 1.0."),
    # 07 node-link: Cora citation network (selection distributed with pygcn, MIT repository).
    "cora-cites": Source(
        "cora", "cora.cites",
        f"{GH}/tkipf/pygcn/{PYGCN_COMMIT}/data/cora/cora.cites",
        "ec1a372391b7f0f60a6aff0084e8abd8f19f0faa7e1f2441a41c492042d5945e", "research-use (see LICENSE.md)",
        "Cora dataset (McCallum et al., 2000; LINQS selection) as distributed with tkipf/pygcn."),
    "cora-content": Source(
        "cora", "cora.content",
        f"{GH}/tkipf/pygcn/{PYGCN_COMMIT}/data/cora/cora.content",
        "b8ebed0fd45e53995abafd1b70cf6a9fcc8f86abc5826d69b97fe6ca46e9c8ee", "research-use (see LICENSE.md)",
        "Cora dataset (McCallum et al., 2000; LINQS selection) as distributed with tkipf/pygcn."),
    # 08 illustration: public-domain / CC0 sample images bundled in the scikit-image sdist.
    "scikit-image-0.26.0-sdist": Source(
        "scikit-image", "scikit_image-0.26.0.tar.gz",
        "https://files.pythonhosted.org/packages/a1/b4/2528bb43c67d48053a7a649a9666432dc307d66ba02e3a6d5c40f46655df/scikit_image-0.26.0.tar.gz",
        "f5f970ab04efad85c24714321fcc91613fcb64ef2a892a13167df2f3e59199fa",
        "BSD-3-Clause (package); images: public domain / CC0",
        "scikit-image sample data: astronaut (NASA, public domain), retina (M. Häggström, CC0), rocket (SpaceX, public domain)."),
}
