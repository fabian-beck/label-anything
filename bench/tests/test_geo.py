"""bench/common/geo.py: simplifying many outlines at once keeps neighbours meeting."""
from __future__ import annotations

import math

from bench.common.geo import simplify_ring, simplify_shared

# a winding border from (0, 0) to (0, 10), shared by two squares
BORDER = [(0.0, 0.0), (0.27, 1.0), (0.27, 2.0), (-0.27, 3.0), (-0.25, 4.0), (0.2, 5.0), (0.14, 6.0),
          (0.1, 7.0), (-0.12, 8.0), (0.06, 9.0), (0.0, 10.0)]
TOL = 0.2
WEST = BORDER + [(-10.0, 10.0), (-10.0, 0.0)]
EAST = BORDER[::-1] + [(10.0, 0.0), (10.0, 10.0)]  # runs the other way


def edges(ring):
    return {frozenset(e) for e in zip(ring, ring[1:] + ring[:1])}


def area(ring):
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])) / 2


def test_a_shared_border_is_simplified_alike_on_both_sides():
    west, east = simplify_shared([WEST, EAST], TOL)
    assert len(west) < len(WEST) and len(east) < len(EAST)
    shared = edges(west) & edges(east)
    # the border is one line again: what is left of it is in both rings
    assert sum(math.dist(*tuple(e)) for e in shared) >= 10.0 - 1e-9
    # simplified one by one, the two sides keep different vertices and no longer meet
    apart = edges(simplify_ring(WEST, TOL)) & edges(simplify_ring(EAST, TOL))
    assert sum(math.dist(*tuple(e)) for e in apart) < 10.0


def test_an_enclave_and_its_hole_stay_the_same_ring():
    circle = [(math.cos(i / 40 * math.tau), math.sin(i / 40 * math.tau)) for i in range(40)]
    hole = circle[7:] + circle[:7]
    hole = hole[:1] + hole[:0:-1]  # starts elsewhere, runs the other way
    enclave, inner = simplify_shared([circle, hole], 0.05)
    assert edges(enclave) == edges(inner)
    assert len(enclave) < len(circle)
    assert (area(enclave) > 0) == (area(circle) > 0) and (area(inner) > 0) == (area(hole) > 0)


def test_the_rings_keep_their_order_and_direction():
    west, east = simplify_shared([WEST, EAST], TOL)
    assert (-10.0, 10.0) in west and (10.0, 0.0) in east
    assert west.index((-10.0, 10.0)) == west.index((-10.0, 0.0)) - 1
