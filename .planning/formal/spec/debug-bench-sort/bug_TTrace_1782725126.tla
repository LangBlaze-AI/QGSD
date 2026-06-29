---- MODULE bug_TTrace_1782725126 ----
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
        x = (2)
        /\
        y = (1)
        /\
        done = (TRUE)
    )
----

_init ==
    /\ done = _TETrace[1].done
    /\ x = _TETrace[1].x
    /\ y = _TETrace[1].y
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ done  = _TETrace[i].done
        /\ done' = _TETrace[j].done
        /\ x  = _TETrace[i].x
        /\ x' = _TETrace[j].x
        /\ y  = _TETrace[i].y
        /\ y' = _TETrace[j].y

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("bug_TTrace_1782725126.json", _TETrace)

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
        done |-> done
        ,x |-> x
        ,y |-> y
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_doneUnchanged |-> done = done'
        
        \* Format the `done` variable as Json value.
        \* ,_doneJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(done)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_doneModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].done # _TETrace[s-1].done
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
\*trace == IODeserialize("bug_TTrace_1782725126.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE bug_TETrace ----
EXTENDS bug, TLC

trace == 
    <<
    ([x |-> 1,y |-> 2,done |-> FALSE]),
    ([x |-> 2,y |-> 1,done |-> TRUE])
    >>
----


=============================================================================

---- CONFIG bug_TTrace_1782725126 ----

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
\* Generated on Mon Jun 29 10:25:27 WEST 2026