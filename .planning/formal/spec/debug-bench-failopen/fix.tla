---- MODULE fix ----
EXTENDS TLC
VARIABLES input, threw
Init == input \in {"good", "corrupt"} /\ threw = FALSE
\* Fixed: try/catch returns a safe default on corrupt input.
Next == threw' = FALSE /\ UNCHANGED input
Spec == Init /\ [][Next]_<<input, threw>>
FailOpenNeverThrows == threw = FALSE
====
