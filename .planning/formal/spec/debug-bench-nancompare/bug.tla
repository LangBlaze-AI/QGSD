---- MODULE bug ----
EXTENDS TLC
VARIABLES val, served
Init == val \in {"finite", "nan"} /\ served = FALSE
\* Buggy TTL check `if (age > ttl) return null`: for age=NaN, (NaN > ttl) is FALSE,
\* so the expiry branch is skipped and the stale/invalid entry is SERVED.
Next == IF val = "nan"
        THEN served' = TRUE /\ UNCHANGED val
        ELSE served' = FALSE /\ UNCHANGED val
Spec == Init /\ [][Next]_<<val, served>>
\* BUG: an invalid (NaN-timestamp) entry must never be served as a cache hit.
InvalidNeverServed == ~(val = "nan" /\ served = TRUE)
====
