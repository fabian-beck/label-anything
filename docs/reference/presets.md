# Presets

A preset is data: `options` merge between the [defaults](defaults.md) and the problem,
`svg_classes` are the class rules of SVG sources without `classes`, and `auto` has the
rules of its adaptive model choice. [Presets and defaults](../concepts/presets-defaults.md)
explains the merge. The files are published with this site under `presets/`.

## auto

The default: zero configuration for any kind of graphic.

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
