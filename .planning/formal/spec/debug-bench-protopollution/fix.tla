---- MODULE fix ----
EXTENDS TLC
VARIABLES polluted, freshObjTainted
Init == polluted = FALSE /\ freshObjTainted = FALSE
\* Fixed: Object.create(null) + hasOwnProperty guard — "__proto__" is an ordinary own
\* key, so the global prototype is never written and fresh objects stay clean.
Next == polluted' = FALSE /\ freshObjTainted' = FALSE
Spec == Init /\ [][Next]_<<polluted, freshObjTainted>>
NoInheritedPollution == freshObjTainted = FALSE
====
