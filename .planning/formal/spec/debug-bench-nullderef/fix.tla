---- MODULE fix ----
EXTENDS TLC
VARIABLES entry, crashed
Init == entry \in {"valid", "null"} /\ crashed = FALSE
\* Fixed: `if (!e || typeof e !== 'object') continue;` — null entries are skipped.
Next == crashed' = FALSE /\ UNCHANGED entry
Spec == Init /\ [][Next]_<<entry, crashed>>
NeverCrash == crashed = FALSE
====
