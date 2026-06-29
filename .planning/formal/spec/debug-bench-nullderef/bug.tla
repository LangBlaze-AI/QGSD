---- MODULE bug ----
EXTENDS TLC
VARIABLES entry, crashed
Init == entry \in {"valid", "null"} /\ crashed = FALSE
\* Buggy: dereferences entry.field with no guard; a "null" entry crashes (TypeError).
Next == IF entry = "null"
        THEN crashed' = TRUE /\ UNCHANGED entry
        ELSE crashed' = FALSE /\ UNCHANGED entry
Spec == Init /\ [][Next]_<<entry, crashed>>
\* BUG: a null/non-object entry must never crash the processor (fail-open contract).
NeverCrash == crashed = FALSE
====
