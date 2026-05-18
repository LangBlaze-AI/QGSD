import { setup, assign, createActor } from 'xstate';
export { createActor };

export interface NFContext {
  slotsAvailable:     number;
  successCount:       number;
  deliberationRounds: number;
  currentPhase:       string;
  maxDeliberation:    number;
  maxSize:            number;   // cap on voters polled per round (--n N - 1 ceiling)
  minLiveVoters:      number;   // floor: minimum live voters for valid consensus (issue #170)
  polledCount:        number;   // agents actually recruited this round
}

export type NFEvent =
  | { type: 'QUORUM_START';    slotsAvailable: number; polledCount: number }
  | { type: 'VOTES_COLLECTED'; successCount: number }
  | { type: 'DELIBERATE' }
  | { type: 'DECIDE';          outcome: 'APPROVE' | 'BLOCK' }
  | { type: 'CIRCUIT_BREAK' };

export const nfWorkflowMachine = setup({
  types: {
    context: {} as NFContext,
    events:  {} as NFEvent,
  },
  guards: {
    minQuorumMet: ({ context }) =>
      context.successCount >= Math.ceil(context.slotsAvailable / 2),

    unanimityMet: ({ context }) =>
      context.successCount === context.polledCount,

    floorMet: ({ context }) =>
      context.successCount >= context.minLiveVoters,

    noInfiniteDeliberation: ({ context }) =>
      context.deliberationRounds < context.maxDeliberation,

    phaseMonotonicallyAdvances: () => true,
  },
}).createMachine({
  id:      'nf-workflow',
  initial: 'IDLE',
  context: {
    slotsAvailable:     0,
    successCount:       0,
    deliberationRounds: 0,
    currentPhase:       'IDLE',
    maxDeliberation:    9,
    maxSize:            3,
    minLiveVoters:      2,
    polledCount:        0,
  },
  states: {
    IDLE: {
      on: {
        QUORUM_START: {
          target: 'COLLECTING_VOTES',
          actions: assign({
            slotsAvailable: ({ event }) => event.slotsAvailable,
            polledCount:    ({ event }) => event.polledCount,
            currentPhase:   () => 'COLLECTING_VOTES',
          }),
        },
        CIRCUIT_BREAK: {
          target: 'IDLE',
        },
        DECIDE: {
          target: 'IDLE',
        },
        VOTES_COLLECTED: {
          target: 'IDLE',
        },
      },
    },
    COLLECTING_VOTES: {
      on: {
        VOTES_COLLECTED: [
          {
            guard: ['unanimityMet', 'floorMet'],
            target:  'DECIDED',
            actions: assign({
              successCount:  ({ event }) => event.successCount,
              currentPhase:  () => 'DECIDED',
            }),
          },
          {
            target:  'DELIBERATING',
            actions: assign({
              successCount:       ({ event }) => event.successCount,
              deliberationRounds: ({ context }) => context.deliberationRounds + 1,
              currentPhase:       () => 'DELIBERATING',
            }),
          },
        ],
        QUORUM_START: {
          target: 'COLLECTING_VOTES',
        },
        CIRCUIT_BREAK: {
          target: 'COLLECTING_VOTES',
        },
        DECIDE: {
          target: 'COLLECTING_VOTES',
        },
      },
    },
    DELIBERATING: {
      on: {
        VOTES_COLLECTED: [
          {
            guard: ['unanimityMet', 'floorMet'],
            target:  'DECIDED',
            actions: assign({
              successCount:  ({ event }) => event.successCount,
              currentPhase:  () => 'DECIDED',
            }),
          },
          {
            guard:   'noInfiniteDeliberation',
            target:  'DELIBERATING',
            actions: assign({
              deliberationRounds: ({ context }) => context.deliberationRounds + 1,
            }),
          },
          {
            target:  'DECIDED',
            actions: assign({ currentPhase: () => 'DECIDED' }),
          },
        ],
        DECIDE: {
          target: 'DECIDED',
        },
        QUORUM_START: {
          target: 'DELIBERATING',
        },
        CIRCUIT_BREAK: {
          target: 'DELIBERATING',
        },
      },
    },
    DECIDED: {
      type: 'final',
      on: {
        DECIDE: {
          target: 'DECIDED',
        },
        CIRCUIT_BREAK: {
          target: 'DECIDED',
        },
        QUORUM_START: {
          target: 'DECIDED',
        },
        VOTES_COLLECTED: {
          target: 'DECIDED',
        },
      },
    },
  },
});
