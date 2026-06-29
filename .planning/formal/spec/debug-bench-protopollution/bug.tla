---- MODULE bug ----
EXTENDS TLC
VARIABLES polluted, freshObjTainted
Init == polluted = FALSE /\ freshObjTainted = FALSE
\* Buggy: obj[key]=v with key reaching "__proto__" writes Object.prototype (step 1);
\* a later freshly-created {} then inherits the attacker-controlled prop (step 2).
Next == \/ (~polluted /\ polluted' = TRUE /\ UNCHANGED freshObjTainted)
        \/ (polluted /\ freshObjTainted' = TRUE /\ UNCHANGED polluted)
Spec == Init /\ [][Next]_<<polluted, freshObjTainted>>
\* BUG: a freshly-created object must never carry attacker-controlled inherited props.
NoInheritedPollution == freshObjTainted = FALSE
====
