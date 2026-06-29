---- MODULE bug ----
EXTENDS Integers
VARIABLES x, y, done
Init == x \in {1, 2} /\ y \in {1, 2} /\ done = FALSE
\* Buggy comparator swaps when x < y -> DESCENDING (faithful to bench-buggy-sort.cjs:
\* `if (a[i] < a[j]) swap`). Self-loop once done so there is no deadlock.
Next == \/ /\ ~done
           /\ done' = TRUE
           /\ IF x < y THEN x' = y /\ y' = x ELSE x' = x /\ y' = y
        \/ /\ done
           /\ UNCHANGED <<x, y, done>>
Spec == Init /\ [][Next]_<<x, y, done>>
\* Same property the JS test asserts: the sorted result is ascending (x <= y).
Ascending == done => (x <= y)
====
