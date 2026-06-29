---- MODULE fix_TTrace_1782723643 ----
EXTENDS Sequences, TLCExt, fix, Toolbox, Naturals, TLC

_expression ==
    LET fix_TEExpression == INSTANCE fix_TEExpression
    IN fix_TEExpression!expression
----

_trace ==
    LET fix_TETrace == INSTANCE fix_TETrace
    IN fix_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        x = (1)
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
    \*         IN J!JsonSerialize("fix_TTrace_1782723643.json", _TETrace)

=============================================================================

 Note that you can extract this module `fix_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `fix_TEExpression.tla` file takes precedence 
  over the module `fix_TEExpression` below).

---- MODULE fix_TEExpression ----
EXTENDS Sequences, TLCExt, fix, Toolbox, Naturals, TLC

expression == 
    [
        \* To hide variables of the `fix` spec from the error trace,
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
\*---- MODULE fix_TETrace ----
\*EXTENDS IOUtils, fix, TLC
\*
\*trace == IODeserialize("fix_TTrace_1782723643.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE fix_TETrace ----
EXTENDS fix, TLC

trace == 
    <<
    ([x |-> 1,y |-> 1,done |-> FALSE]),
    ([x |-> 1,y |-> 1,done |-> TRUE])
    >>
----


=============================================================================

---- CONFIG fix_TTrace_1782723643 ----

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
\* Generated on Mon Jun 29 10:00:44 WEST 2026