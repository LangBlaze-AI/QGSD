---- MODULE fix ----
EXTENDS TLC
VARIABLES val, served
Init == val \in {"finite", "nan"} /\ served = FALSE
\* Fixed: `if (!Number.isFinite(created) || age > ttl) return null` — NaN rejected.
Next == served' = FALSE /\ UNCHANGED val
Spec == Init /\ [][Next]_<<val, served>>
InvalidNeverServed == ~(val = "nan" /\ served = TRUE)
====
