---- MODULE bug_TTrace_1782723636 ----
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
        oob = (TRUE)
        /\
        i = (4)
    )
----

_init ==
    /\ oob = _TETrace[1].oob
    /\ i = _TETrace[1].i
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ oob  = _TETrace[i].oob
        /\ oob' = _TETrace[j].oob
        /\ i  = _TETrace[i].i
        /\ i' = _TETrace[j].i

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("bug_TTrace_1782723636.json", _TETrace)

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
        oob |-> oob
        ,i |-> i
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_oobUnchanged |-> oob = oob'
        
        \* Format the `oob` variable as Json value.
        \* ,_oobJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(oob)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_oobModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].oob # _TETrace[s-1].oob
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
\*trace == IODeserialize("bug_TTrace_1782723636.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE bug_TETrace ----
EXTENDS bug, TLC

trace == 
    <<
    ([oob |-> FALSE,i |-> 0]),
    ([oob |-> FALSE,i |-> 1]),
    ([oob |-> FALSE,i |-> 2]),
    ([oob |-> FALSE,i |-> 3]),
    ([oob |-> TRUE,i |-> 4])
    >>
----


=============================================================================

---- CONFIG bug_TTrace_1782723636 ----

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
\* Generated on Mon Jun 29 10:00:36 WEST 2026