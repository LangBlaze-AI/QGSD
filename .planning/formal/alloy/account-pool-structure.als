-- formal/alloy/account-pool-structure.als
-- Handwritten — not generated from XState.
-- Source: bin/account-manager.cjs
--
-- QGSD Account Pool Structure Model (Alloy 6)
-- Requirements: ALY-AM-01
--
-- Models the structural invariants of the OAuth credential pool:
--   ValidState          : active account (when set) is a member of the pool
--   AddPreservesValidity    : AddOp maintains structural invariants
--   SwitchPreservesValidity : SwitchOp maintains structural invariants
--   RemovePreservesValidity : RemoveOp maintains structural invariants
--   SwitchPreservesPool     : SwitchOp never modifies the pool membership
--   RemoveShrinksPool       : RemoveOp reduces pool size by exactly one
--
-- Scope: 5 accounts, 5 pool states.

module account_pool_structure

-- Account: opaque atom representing one credential (email or alias)
abstract sig Account {}

-- PoolState: snapshot of the credential pool at one point in time.
-- Maps to the on-disk layout:
--   pool   — files in ~/.gemini/accounts/*.json
--   active — name stored in ~/.gemini/accounts/.qgsd-active (lone = 0 or 1)
sig PoolState {
    pool:   set Account,
    active: lone Account
}

-- ValidState: the two structural invariants from QGSDAccountManager.tla
--   ActiveIsPoolMember : active ∈ pool  (or active absent — lone handles this)
--   NoActiveWhenEmpty  : pool = {} ⇒ active absent  (implied by active ∈ pool)
pred ValidState [s: PoolState] {
    s.active in s.pool
}

-- ── Operations ────────────────────────────────────────────────────────────────

-- AddOp: captures a new credential into the pool.
-- Guard: new not already in pool.
-- If pool was empty, new account becomes active; otherwise active is preserved.
-- Mirrors: TLA+ StartAdd → OAuthSuccess → SaveOk
pred AddOp [pre, post: PoolState, new: Account] {
    new !in pre.pool
    post.pool = pre.pool + new
    no pre.pool  => post.active = new
    some pre.pool => post.active = pre.active
}

-- SwitchOp: changes the active credential to an existing pool member.
-- Guard: target must already be in pool.
-- Pool membership is unchanged.
-- Mirrors: TLA+ StartSwitch → SwapOk
pred SwitchOp [pre, post: PoolState, target: Account] {
    target in pre.pool
    post.pool   = pre.pool
    post.active = target
}

-- RemoveOp: removes a credential from the pool.
-- Guard: account must exist in pool.
-- If removed account was active, active rotates to any remaining member (nondeterministic).
-- If pool becomes empty, active is cleared.
-- Mirrors: TLA+ StartRemove → RemoveOk (CHOOSE a ∈ pool' : TRUE)
pred RemoveOp [pre, post: PoolState, removed: Account] {
    removed in pre.pool
    post.pool = pre.pool - removed
    -- Active unchanged if not the removed account
    pre.active != removed =>
        post.active = pre.active
    -- Active rotates when removing the active account
    pre.active = removed => (
        (no post.pool  => no post.active) and
        (some post.pool => post.active in post.pool)
    )
}

-- ── Assertions ────────────────────────────────────────────────────────────────

-- AddPreservesValidity: adding to a valid state yields a valid state
-- @requirement CRED-07
assert AddPreservesValidity {
    all pre, post: PoolState, new: Account |
        ValidState[pre] and AddOp[pre, post, new] => ValidState[post]
}

-- SwitchPreservesValidity: switching in a valid state yields a valid state
-- @requirement CRED-08
assert SwitchPreservesValidity {
    all pre, post: PoolState, target: Account |
        ValidState[pre] and SwitchOp[pre, post, target] => ValidState[post]
}

-- RemovePreservesValidity: removing from a valid state yields a valid state
-- @requirement CRED-09
assert RemovePreservesValidity {
    all pre, post: PoolState, removed: Account |
        ValidState[pre] and RemoveOp[pre, post, removed] => ValidState[post]
}

-- SwitchPreservesPool: switch never adds or removes accounts from the pool
-- @requirement CRED-10
assert SwitchPreservesPool {
    all pre, post: PoolState, target: Account |
        SwitchOp[pre, post, target] => post.pool = pre.pool
}

-- RemoveShrinksPool: remove always reduces pool size by exactly one
-- @requirement CRED-11
assert RemoveShrinksPool {
    all pre, post: PoolState, removed: Account |
        RemoveOp[pre, post, removed] => #post.pool = minus[#pre.pool, 1]
}

-- ── Check commands ────────────────────────────────────────────────────────────
check AddPreservesValidity    for 5 Account, 5 PoolState
check SwitchPreservesValidity for 5 Account, 5 PoolState
check RemovePreservesValidity for 5 Account, 5 PoolState
check SwitchPreservesPool     for 5 Account, 5 PoolState
check RemoveShrinksPool       for 5 Account, 5 PoolState

-- Witness: confirm a valid state with 2 accounts exists
run { some s: PoolState | ValidState[s] and #s.pool = 2 } for 3 Account, 1 PoolState
