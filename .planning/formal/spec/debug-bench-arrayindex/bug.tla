---- MODULE bug ----
EXTENDS Naturals
VARIABLES i, oob
Init == i = 0 /\ oob = FALSE
\* Buggy loop bound `i <= 3` reads a[3], but valid indices are 0..2 -> out of bounds.
Next == IF i < 3
        THEN i' = i + 1 /\ UNCHANGED oob
        ELSE IF i = 3
             THEN oob' = TRUE /\ i' = i + 1
             ELSE UNCHANGED <<i, oob>>
Spec == Init /\ [][Next]_<<i, oob>>
\* BUG: array index must stay within bounds (0..len-1).
IndexInBounds == oob = FALSE
====
