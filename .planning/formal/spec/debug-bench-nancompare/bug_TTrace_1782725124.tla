---- MODULE bug_TTrace_1782725124 ----
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
        val = ("nan")
        /\
        served = (TRUE)
    )
----

_init ==
    /\ val = _TETrace[1].val
    /\ served = _TETrace[1].served
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ val  = _TETrace[i].val
        /\ val' = _TETrace[j].val
        /\ served  = _TETrace[i].served
        /\ served' = _TETrace[j].served

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("bug_TTrace_1782725124.json", _TETrace)

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
        val |-> val
        ,served |-> served
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_valUnchanged |-> val = val'
        
        \* Format the `val` variable as Json value.
        \* ,_valJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(val)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_valModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].val # _TETrace[s-1].val
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
\*trace == IODeserialize("bug_TTrace_1782725124.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE bug_TETrace ----
EXTENDS bug, TLC

trace == 
    <<
    ([val |-> "nan",served |-> FALSE]),
    ([val |-> "nan",served |-> TRUE])
    >>
----


=============================================================================

---- CONFIG bug_TTrace_1782725124 ----

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
\* Generated on Mon Jun 29 10:25:24 WEST 2026