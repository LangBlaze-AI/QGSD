---- MODULE fix ----
EXTENDS Naturals
VARIABLES i, oob
Init == i = 0 /\ oob = FALSE
\* Fixed loop bound `i < 3` reads only a[0..2] -> never out of bounds.
Next == IF i < 3
        THEN i' = i + 1 /\ UNCHANGED oob
        ELSE UNCHANGED <<i, oob>>
Spec == Init /\ [][Next]_<<i, oob>>
IndexInBounds == oob = FALSE
====
