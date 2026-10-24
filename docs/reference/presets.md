# Presets

A preset is a named set of option values for one kind of graphic. The options that apply
are the [defaults](defaults.md), then the preset's, then the problem's own:

> effective options = defaults ← preset ← problem

Objects merge recursively, while arrays and scalars replace; the class maps of `avoid`
merge key by key. So `{"preset": "map", "avoid": {"label": {"roads": "hard"}}}` keeps
everything the `map` preset sets and adds one class.

| Preset | For |
|---|---|
| [`auto`](#auto) (default) | anything, without configuration |
| [`scatter`](#scatter) | scatter plots: point marks over dense unlabeled points, trend lines, axes |
| [`map`](#map) | point features over map backgrounds |
| [`graph`](#graph) | node-link diagrams |
| [`illustration`](#illustration) | technical and anatomical illustrations, labeled in the margins |
| [`none`](#none) | full control: the defaults alone |

Each preset is a JSON file: its `description` says what it sets, its `options` merge as
above, and its `svg_classes` are the class rules for SVG sources without `classes` of their
own. `auto` also holds the rule of its adaptive model choice. The files are published with
this site under `presets/`.

## auto

```json
--8<-- "spec/presets/auto.json"
```

## scatter

```json
--8<-- "spec/presets/scatter.json"
```

## map

```json
--8<-- "spec/presets/map.json"
```

## graph

```json
--8<-- "spec/presets/graph.json"
```

## illustration

```json
--8<-- "spec/presets/illustration.json"
```

## none

```json
--8<-- "spec/presets/none.json"
```
