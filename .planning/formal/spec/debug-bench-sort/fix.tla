---- MODULE fix ----
EXTENDS Integers
VARIABLES x, y, done
Init == x \in {1, 2} /\ y \in {1, 2} /\ done = FALSE
\* Fixed comparator swaps when x > y -> ascending (JS fix: change `<` to `>`).
Next == \/ /\ ~done
           /\ done' = TRUE
           /\ IF x > y THEN x' = y /\ y' = x ELSE x' = x /\ y' = y
        \/ /\ done
           /\ UNCHANGED <<x, y, done>>
Spec == Init /\ [][Next]_<<x, y, done>>
Ascending == done => (x <= y)
====
