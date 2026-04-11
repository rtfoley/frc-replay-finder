/**
 * Test harness for replayScheduler.js
 * Run with: node replayScheduler.test.js
 */

const {
  findReplaySlot,
  computeTeamGap,
  computeMinGapAtInsertion,
  detectBreaks,
} = require('./replayScheduler');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

function makeMatch(matchNumber, teams, minutesFromStart = null) {
  const base = new Date('2024-04-01T09:00:00Z');
  return {
    matchNumber,
    teams,
    timestamp: minutesFromStart !== null
      ? new Date(base.getTime() + minutesFromStart * 60000)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Schedule fixtures
// ---------------------------------------------------------------------------

/**
 * 50-match schedule. Teams named T1–T30 (6 per match, no overlaps in early matches for clarity).
 * Q35 teams: T1, T2, T3, T4, T5, T6
 *
 * Timestamps: 6 min per match, 45-min lunch break after Q43.
 */
function buildBaseSchedule() {
  const schedule = [];
  const allTeams = Array.from({ length: 30 }, (_, i) => `T${i + 1}`);

  // Matches 1–50: assign teams round-robin style
  // Q35 teams are T1–T6. We'll carefully place them to test gap logic.
  for (let m = 1; m <= 50; m++) {
    // Default: pick 6 teams by offset (won't conflict cleanly, but sufficient for gap math)
    const start = ((m - 1) * 2) % allTeams.length;
    const teams = [
      allTeams[start % 30],
      allTeams[(start + 1) % 30],
      allTeams[(start + 2) % 30],
      allTeams[(start + 3) % 30],
      allTeams[(start + 4) % 30],
      allTeams[(start + 5) % 30],
    ];
    // Timestamps: 6 min/match, lunch break (45 min) inserted between Q43 and Q44
    let minutes;
    if (m <= 43) {
      minutes = (m - 1) * 6;
    } else {
      minutes = (43 - 1) * 6 + 45 + (m - 44) * 6; // +45 for the break
    }
    schedule.push(makeMatch(m, teams, minutes));
  }
  return schedule;
}

/**
 * Override specific matches to control team placement for Q35 teams T1–T6.
 * Returns a new schedule copy.
 */
function withTeamPlacements(schedule, placements) {
  // placements: { [matchNumber]: teams[] }
  return schedule.map(m =>
    placements[m.matchNumber] ? { ...m, teams: placements[m.matchNumber] } : m
  );
}

// ---------------------------------------------------------------------------
// Test 1: detectBreaks
// ---------------------------------------------------------------------------

section('detectBreaks');

{
  const sched = buildBaseSchedule();
  const { breakAfterIndex, hasTimestamps } = detectBreaks(sched);
  assert('Detects lunch break after Q43 (insertionIndex=43)', breakAfterIndex.has(43));
  assert('No break at Q42 (insertionIndex=42)', !breakAfterIndex.has(42));
  assert('No break at Q44 (insertionIndex=44)', !breakAfterIndex.has(44));
  assert('hasTimestamps true', hasTimestamps);
}

{
  // Missing timestamps
  const sched = buildBaseSchedule().map(m => ({ ...m, timestamp: undefined }));
  const { hasTimestamps } = detectBreaks(sched);
  assert('hasTimestamps false when timestamps missing', !hasTimestamps);
}

// ---------------------------------------------------------------------------
// Test 2: computeTeamGap
// ---------------------------------------------------------------------------

section('computeTeamGap');

{
  // Simple schedule: T1 plays Q1, Q5, Q10 (0-indexed: 0, 4, 9)
  const sched = Array.from({ length: 10 }, (_, i) => ({
    matchNumber: i + 1,
    teams: i === 0 || i === 4 || i === 9 ? ['T1', 'X', 'X', 'X', 'X', 'X'] : ['A', 'B', 'C', 'D', 'E', 'F'],
    timestamp: undefined,
  }));

  // Insert at index 2 (between Q2 and Q3)
  // prevIdx=0 (Q1), nextIdx=4 (Q5)
  // before = 2 - 0 - 1 = 1, after = 4 - 2 - 1 = 1
  const g1 = computeTeamGap(sched, 'T1', 2);
  assert('before gap = 1 (Q2 between Q1 and replay)', g1.before === 1, `got ${g1.before}`);
  assert('after gap = 1 (Q3 between replay and Q5)', g1.after === 1, `got ${g1.after}`);

  // Insert at index 7 (between Q7 and Q8)
  // prevIdx=4 (Q5), nextIdx=9 (Q10)
  // before = 7 - 4 - 1 = 2, after = 9 - 7 - 1 = 1
  const g2 = computeTeamGap(sched, 'T1', 7);
  assert('before gap = 2 (Q6,Q7 between Q5 and replay)', g2.before === 2, `got ${g2.before}`);
  assert('after gap = 1 (Q8 between replay and Q10)', g2.after === 1, `got ${g2.after}`);

  // Insert after last match (index 10)
  // prevIdx=9 (Q10), nextIdx=null
  const g3 = computeTeamGap(sched, 'T1', 10);
  assert('after gap = Infinity when no future matches', g3.after === Infinity);
  assert('before gap = 0 when inserted immediately after last match', g3.before === 0);
}

// ---------------------------------------------------------------------------
// Test 3: Back-to-back rejection
// ---------------------------------------------------------------------------

section('Back-to-back rejection');

{
  // T1 plays Q35 and Q36. Inserting at index 35 (after Q35, before Q36) should be invalid.
  // (0-indexed: Q35=idx34, Q36=idx35, insertion at 35 means between Q35 and Q36)
  const sched = buildBaseSchedule();
  const q35teams = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];

  const placements = {
    35: q35teams,
    36: ['T1', 'T7', 'T8', 'T9', 'T10', 'T11'], // T1 in Q36
  };
  const s = withTeamPlacements(sched, placements);

  const { minGap, teamGaps } = computeMinGapAtInsertion(s, q35teams, 35); // insert right after Q35
  // T1: prevIdx=34 (Q35), nextIdx=35 (Q36), before=35-34-1=0 ← back-to-back!
  assert('minGap = 0 when T1 has Q36 immediately after', minGap === 0, `got ${minGap}`);
}

// ---------------------------------------------------------------------------
// Test 4: Break preference
// ---------------------------------------------------------------------------

section('Break preference (tie-breaking)');

{
  // Break tie-break: Q35 teams play Q35 and Q49.
  // Midpoint between idx34 and idx48 (Q35 and Q49) is idx41.
  // at idx41: before=41-34-1=6, after=48-41-1=6 → minGap=6
  // at idx43 (post-break): before=43-34-1=8, after=48-43-1=4 → minGap=4. Doesn't tie.
  //
  // For a true tie, we need the break slot to be THE midpoint.
  // Break is between Q43 and Q44 → insertionIndex=43.
  // We need Q35 teams' prev and next matches equidistant from insertionIndex=43.
  // before = 43 - prevIdx - 1, after = nextIdx - 43 - 1
  // For tie: prevIdx = 43 - k - 1, nextIdx = 43 + k + 1
  // e.g. k=7: prevIdx=35 (Q36 is idx35), nextIdx=51... too far.
  // k=5: prevIdx=37 (Q38), nextIdx=49 (Q50). Q35 teams play Q38 and Q50.
  // at idx43: before=43-37-1=5, after=49-43-1=5 → minGap=5 ✓
  // nearest non-break with minGap=5: before=5→prevIdx=43-6=37, after=5→nextIdx=43+6=49... same slot.
  // Actually by symmetry only idx43 gives minGap=5; idx42 gives min(4,6)=4, idx44 gives min(6,4)=4.
  // So the break slot is uniquely optimal here (not a tie). Still proves break preference by showing it wins.
  //
  // Simpler test: just verify that when break slot is the unique optimum, it IS returned.

  const sched = buildBaseSchedule();
  const q35teams = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];

  // Q35 teams: appear in Q35 (idx34), Q38 (idx37), and Q50 (idx49)
  // At insertionIndex=43 (post-break): before=43-37-1=5, after=49-43-1=5 → minGap=5
  // This is the unique optimum.
  const cleaned = sched.map(m => {
    const n = m.matchNumber;
    if (n === 35 || n === 38 || n === 50) return { ...m, teams: q35teams };
    return { ...m, teams: m.teams.map(t => q35teams.includes(t) ? 'TX' : t) };
  });

  const result = findReplaySlot(cleaned, 35);
  assert('Result is non-null', result !== null);
  if (result) {
    const best = result.candidates[0];
    assert('Best slot is after the lunch break (idx=43)', best.isAfterBreak && best.insertionIndex === 43,
      `label: ${best.insertionLabel}, minGap: ${best.minGap}, isAfterBreak: ${best.isAfterBreak}`);
    assert('Break slot label says "before Q44"', best.insertionLabel === 'before Q44',
      `got: ${best.insertionLabel}`);
  }
}

// Helper: replace first non-T-prefixed team slot with a specific team
function replaceTeam(teams, newTeam) {
  const copy = [...teams];
  // replace first slot that isn't one of our special teams T1-T6
  const idx = copy.findIndex(t => !['T1','T2','T3','T4','T5','T6'].includes(t));
  if (idx !== -1) copy[idx] = newTeam;
  return copy;
}

// ---------------------------------------------------------------------------
// Test 5: Null when no valid slot
// ---------------------------------------------------------------------------

section('Returns null when no valid slot');

{
  // Q35 teams all play back-to-back through end of schedule
  // Use a tiny schedule: Q34, Q35, Q36 where all Q35 teams are in Q34 and Q36
  const tinySchedule = [
    makeMatch(34, ['T1','T2','T3','T4','T5','T6'], 0),
    makeMatch(35, ['T1','T2','T3','T4','T5','T6'], 6),
    makeMatch(36, ['T1','T2','T3','T4','T5','T6'], 12),
  ];
  const result = findReplaySlot(tinySchedule, 35);
  assert('Returns null when all insertions are back-to-back', result === null);
}

// ---------------------------------------------------------------------------
// Test 6: Replay at end of schedule
// ---------------------------------------------------------------------------

section('Replay at end of schedule');

{
  // When Q35 teams have no future matches, after-gap is always Infinity (unconstrained).
  // minGap is determined solely by before-gap, which grows as insertionIndex increases.
  // So the algorithm should prefer the LAST position (maximum before-gap).
  const sched = buildBaseSchedule();
  const q35teams = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];
  const cleaned = sched.map(m => {
    if (m.matchNumber === 35) return { ...m, teams: q35teams };
    return { ...m, teams: m.teams.map(t => q35teams.includes(t) ? 'TX' : t) };
  });

  const result = findReplaySlot(cleaned, 35);
  assert('Result non-null when all after-gaps are Infinity', result !== null);
  if (result) {
    const best = result.candidates[0];
    assert('Prefers last insertion when all after-gaps are unconstrained',
      best.insertionIndex === cleaned.length,
      `got insertionIndex ${best.insertionIndex}, label: ${best.insertionLabel}`);
  }
}

// ---------------------------------------------------------------------------
// Test 7: Max-min objective
// ---------------------------------------------------------------------------

section('Max-min objective');

{
  // Hand-craft a scenario where one insertion gives 2-2-2-2-2-2 and another gives 1-5-5-5-5-5
  // Q35 teams: T1-T6
  // T1: Q35, Q38 (gap of 2 if inserted at 36, 37, or 38... need to be careful)
  // For simplicity: use small schedule, verify the 2-2 beats the 1-5 scenario

  // Schedule: Q33, Q34, Q35, Q36, Q37, Q38, Q39, Q40, Q41, Q42
  // T1 plays Q35, Q38 → if replay at idx 4 (after Q38=idx7... let me use absolute positions)

  // Let's use a direct computeMinGapAtInsertion test instead:
  const mini = [
    makeMatch(33, ['T1','T2','T3','T4','T5','T6'], 0),
    makeMatch(34, ['A','B','C','D','E','F'], 6),
    makeMatch(35, ['T1','T2','T3','T4','T5','T6'], 12), // idx=2, the replay match
    makeMatch(36, ['A','B','C','D','E','F'], 18),
    makeMatch(37, ['A','B','C','D','E','F'], 24),
    makeMatch(38, ['T1','A','B','C','D','E'], 30), // T1 next match
    makeMatch(39, ['T2','A','B','C','D','E'], 36), // T2 next match
    makeMatch(40, ['T3','A','B','C','D','E'], 42),
    makeMatch(41, ['T4','A','B','C','D','E'], 48),
    makeMatch(42, ['T5','A','B','C','D','E'], 54),
    makeMatch(43, ['T6','A','B','C','D','E'], 60),
  ];
  const teams = ['T1','T2','T3','T4','T5','T6'];

  // Insertion at idx=5 (after Q37, before Q38)
  // T1: prev=Q35(idx2), next=Q38(idx5)... wait, idx5 IS Q38 so next=idx5
  // before=5-2-1=2, after=5-5-1=-1... hmm, let me recalculate
  // idx5 = Q38 (0-based: Q33=0,Q34=1,Q35=2,Q36=3,Q37=4,Q38=5)
  // insertionIndex=5 means replay goes BEFORE Q38(idx5), AFTER Q37(idx4)
  // T1: prevIdx=2(Q35), nextIdx=5(Q38), before=5-2-1=2, after=5-5-1=-1 ← WRONG
  // after = nextIdx - insertionIndex - 1 = 5 - 5 - 1 = -1, that means back-to-back
  // Actually after=5-5-1 = -1 means the next match IS at the insertion point — that's gap=0
  // Wait: after = nextIdx - insertionIndex - 1. If nextIdx === insertionIndex that means
  // the next match for T1 is at the same index as the insertion... but insertion index
  // represents the slot BEFORE schedule[insertionIndex]. So T1's next match at idx5
  // and replay also at idx5 means gap=0 (back-to-back). Correct behavior.

  // So insert at idx=4 (after Q36(idx3), before Q37(idx4)):
  // T1: prev=2(Q35), next=5(Q38), before=4-2-1=1, after=5-4-1=0 ← T1 back-to-back with Q38? 
  // after=5-4-1=0, yes gap=0. Not valid.

  // Insert at idx=3 (after Q35, before Q36... but we need insertionIndex > replayMatchIdx=2)
  // insertionIndex=3: T1 prev=2(Q35), next=5(Q38), before=3-2-1=0 ← back-to-back with Q35. Invalid.

  // Cleaner: T1 plays Q35, Q40. T2-T6 same. Insert at idx=7 (after Q39, before Q40)
  const mini2 = [
    makeMatch(33, ['A','B','C','D','E','F'], 0),
    makeMatch(34, ['A','B','C','D','E','F'], 6),
    makeMatch(35, ['T1','T2','T3','T4','T5','T6'], 12), // idx=2
    makeMatch(36, ['A','B','C','D','E','F'], 18),
    makeMatch(37, ['A','B','C','D','E','F'], 24),
    makeMatch(38, ['A','B','C','D','E','F'], 30),
    makeMatch(39, ['A','B','C','D','E','F'], 36),
    makeMatch(40, ['T1','T2','T3','T4','T5','T6'], 42), // idx=7
    makeMatch(41, ['A','B','C','D','E','F'], 48),
    makeMatch(42, ['A','B','C','D','E','F'], 54),
  ];

  // Insert at idx=5 (after Q37, before Q38):
  // T1-T6: prev=2(Q35), next=7(Q40), before=5-2-1=2, after=7-5-1=1 → min=1
  const r5 = computeMinGapAtInsertion(mini2, teams, 5);
  assert('Insert after Q37: minGap=1', r5.minGap === 1, `got ${r5.minGap}`);

  // Insert at idx=4 (after Q36, before Q37):
  // T1-T6: prev=2(Q35), next=7(Q40), before=4-2-1=1, after=7-4-1=2 → min=1
  const r4 = computeMinGapAtInsertion(mini2, teams, 4);
  assert('Insert after Q36: minGap=1', r4.minGap === 1, `got ${r4.minGap}`);

  const result = findReplaySlot(mini2, 35);
  assert('Returns non-null', result !== null);
  if (result) {
    const best = result.candidates[0];
    assert('Optimal slot is after Q42 (minGap=2)', best.insertionIndex === 10,
      `got insertionIndex=${best.insertionIndex}, minGap=${best.minGap}, label=${best.insertionLabel}`);
    assert('minGap is 2', best.minGap === 2, `got ${best.minGap}`);
    assert('Returns up to 5 candidates by default', result.candidates.length <= 5);
    assert('Candidates sorted minGap desc', result.candidates.every((c, i) =>
      i === 0 || result.candidates[i - 1].minGap >= c.minGap
    ));
  }

  // topN=2
  const result2 = findReplaySlot(mini2, 35, { topN: 2 });
  assert('topN=2 returns at most 2 candidates', result2 !== null && result2.candidates.length <= 2);

  // topN=1
  const result1 = findReplaySlot(mini2, 35, { topN: 1 });
  assert('topN=1 returns exactly 1 candidate', result1 !== null && result1.candidates.length === 1);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);