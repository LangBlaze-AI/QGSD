---- MODULE bug ----
EXTENDS TLC
VARIABLES input, threw
Init == input \in {"good", "corrupt"} /\ threw = FALSE
\* Buggy: JSON.parse(corrupt) / unguarded deref throws and propagates (fail-CLOSED).
Next == IF input = "corrupt"
        THEN threw' = TRUE /\ UNCHANGED input
        ELSE threw' = FALSE /\ UNCHANGED input
Spec == Init /\ [][Next]_<<input, threw>>
\* BUG: a fail-open helper must degrade on corrupt input, never throw.
FailOpenNeverThrows == threw = FALSE
====
