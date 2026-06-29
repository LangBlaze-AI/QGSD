---- MODULE bug_TTrace_1782721057 ----
EXTENDS Sequences, TLCExt, bug, Toolbox, Naturals, TLC

_expression ==
    LET bug_TEExpression == INSTANCE bug_TEExpression
    IN bug_TEExpression!expression
----

_trace ==
    LET bug_TETrace == INSTANCE bug_TETrace
    IN bug_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        a = (1)
        /\
        b = (1)
        /\
        swapped = (TRUE)
    )
----

_init ==
    /\ a = _TETrace[1].a
    /\ b = _TETrace[1].b
    /\ swapped = _TETrace[1].swapped
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ a  = _TETrace[i].a
        /\ a' = _TETrace[j].a
        /\ b  = _TETrace[i].b
        /\ b' = _TETrace[j].b
        /\ swapped  = _TETrace[i].swapped
        /\ swapped' = _TETrace[j].swapped

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("bug_TTrace_1782721057.json", _TETrace)

=============================================================================

 Note that you can extract this module `bug_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `bug_TEExpression.tla` file takes precedence 
  over the module `bug_TEExpression` below).

---- MODULE bug_TEExpression ----
EXTENDS Sequences, TLCExt, bug, Toolbox, Naturals, TLC

expression == 
    [
        \* To hide variables of the `bug` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        a |-> a
        ,b |-> b
        ,swapped |-> swapped
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_aUnchanged |-> a = a'
        
        \* Format the `a` variable as Json value.
        \* ,_aJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(a)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_aModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].a # _TETrace[s-1].a
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE bug_TETrace ----
\*EXTENDS IOUtils, bug, TLC
\*
\*trace == IODeserialize("bug_TTrace_1782721057.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE bug_TETrace ----
EXTENDS bug, TLC

trace == 
    <<
    ([a |-> 1,b |-> 1,swapped |-> FALSE]),
    ([a |-> 1,b |-> 1,swapped |-> TRUE])
    >>
----


=============================================================================

---- CONFIG bug_TTrace_1782721057 ----

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Mon Jun 29 09:17:37 WEST 2026