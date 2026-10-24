# Presets

A preset is a JSON file: its `options` merge between the [defaults](defaults.md) and the
problem, its `svg_classes` are the class rules for SVG sources without `classes`, and
`auto` also holds the rule of its adaptive model choice.
[Presets and defaults](../concepts/presets-defaults.md) explains the merge; the files are
published with this site under `presets/`.

## auto

The default, for any kind of graphic, without configuration.

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
