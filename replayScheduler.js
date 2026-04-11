/**
 * FRC Match Replay Scheduler
 * Core algorithm — no UI dependencies, framework-agnostic.
 *
 * Terminology:
 *   match        — { matchNumber: number, teams: string[], timestamp?: Date }
 *   schedule     — ordered array of matches (ascending matchNumber)
 *   insertionIndex — integer i means replay is inserted BETWEEN schedule[i-1] and schedule[i]
 *                    i.e. replay sits at position i in the 0-based array after insertion
 *   gap          — count of match slots between two appearances (exclusive of both endpoints)
 *                  e.g. Q41 and Q46 with nothing inserted → gap = 4 (Q42,Q43,Q44,Q45)
 *                  if replay is inserted at position 3 (between Q43 and Q44), it becomes a boundary
 */

// ---------------------------------------------------------------------------
// Break detection
// ---------------------------------------------------------------------------

const BREAK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Returns a Set of insertion indices that immediately follow a scheduled break.
 * insertionIndex i means "replay goes before schedule[i]", i.e. after schedule[i-1].
 * A break exists between schedule[i-1] and schedule[i] when their timestamp gap >= threshold.
 *
 * @param {Array} schedule
 * @returns {{ breakAfterIndex: Set<number>, hasTimestamps: boolean }}
 */
function detectBreaks(schedule) {
  const breakAfterIndex = new Set(); // insertion index i = break between i-1 and i
  let hasTimestamps = true;

  for (let i = 1; i < schedule.length; i++) {
    const prev = schedule[i - 1];
    const curr = schedule[i];

    if (!prev.timestamp || !curr.timestamp) {
      hasTimestamps = false;
      continue;
    }

    const gap = new Date(curr.timestamp) - new Date(prev.timestamp);
    if (gap >= BREAK_THRESHOLD_MS) {
      breakAfterIndex.add(i); // replay at index i = first match after the break
    }
  }

  return { breakAfterIndex, hasTimestamps };
}

// ---------------------------------------------------------------------------
// Gap computation
// ---------------------------------------------------------------------------

/**
 * For a team, find their previous match index (before insertionIndex)
 * and next match index (at or after insertionIndex) in the schedule.
 * The replay itself occupies insertionIndex, so "next" is >= insertionIndex.
 *
 * Returns { prevIdx: number|null, nextIdx: number|null }
 */
function findAdjacentMatches(schedule, team, insertionIndex) {
  let prevIdx = null;
  let nextIdx = null;

  for (let i = 0; i < schedule.length; i++) {
    if (!schedule[i].teams.includes(team)) continue;

    if (i < insertionIndex) {
      prevIdx = i; // keep updating — want the closest one before
    } else if (nextIdx === null) {
      nextIdx = i; // first one at or after insertion
    }
  }

  return { prevIdx, nextIdx };
}

/**
 * Compute the before-gap and after-gap for a team at a given insertion index.
 *
 * Before-gap: number of schedule slots between prevIdx and insertionIndex (exclusive of both).
 *   = insertionIndex - prevIdx - 1
 *   If no prevIdx → Infinity (team hasn't played yet before this point — unconstrained)
 *
 * After-gap: number of schedule slots between insertionIndex and nextIdx (exclusive of both).
 *   = nextIdx - insertionIndex - 1
 *   If no nextIdx → Infinity (no more matches for this team — unconstrained)
 *
 * Note: The replay occupies insertionIndex. It is NOT counted in either gap.
 *
 * @param {Array} schedule
 * @param {string} team
 * @param {number} insertionIndex  0-based index where replay is inserted
 * @returns {{ before: number, after: number }}
 */
function computeTeamGap(schedule, team, insertionIndex) {
  const { prevIdx, nextIdx } = findAdjacentMatches(schedule, team, insertionIndex);

  // Before gap is correct: count matches between prev and where we are sticking the replay
  const before = prevIdx === null
    ? Infinity
    : insertionIndex - prevIdx - 1;

  // After gap was wrong: nextIdx is the index in the CURRENT schedule.
  // Because the replay will TAKE the insertionIndex, the match that was at 
  // nextIdx stays at nextIdx (it just refers to the next match in the list).
  const after = nextIdx === null
    ? Infinity
    : nextIdx - insertionIndex; // Removed the -1

  return { before, after };
}

/**
 * Compute the min gap across all teams at a given insertion index.
 * Infinity gaps (no prev or no next match) are treated as unconstrained — excluded
 * from the min calculation so they don't artificially inflate the score.
 * If ALL gaps are Infinity (no team has a constrained side), returns Infinity.
 *
 * A gap of -1 can result when nextIdx === insertionIndex (the team's next match IS
 * the slot immediately taken by the replay — effectively gap 0, back-to-back).
 * We clamp to 0 so the validity check catches it correctly.
 *
 * @param {Array} schedule
 * @param {string[]} teams  — 6 teams from the replay match
 * @param {number} insertionIndex
 * @returns {{ minGap: number, teamGaps: Object }}
 */
function computeMinGapAtInsertion(schedule, teams, insertionIndex) {
  const teamGaps = {};
  const constrainedGaps = [];

  for (const team of teams) {
    let { before, after } = computeTeamGap(schedule, team, insertionIndex);

    // Clamp: gap cannot be negative (indicates the replay lands on top of a match)
    before = Math.max(before, 0);
    after = Math.max(after, 0);

    teamGaps[team] = { before, after };

    if (before !== Infinity) constrainedGaps.push(before);
    if (after !== Infinity) constrainedGaps.push(after);
  }

  const minGap = constrainedGaps.length > 0
    ? Math.min(...constrainedGaps)
    : Infinity;

  return { minGap, teamGaps };
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/**
 * Find the best insertion points for a replay match.
 *
 * @param {Array}  schedule            Ordered array of { matchNumber, teams, timestamp? }
 * @param {number} replayMatchNumber   Match to replay (e.g. 35)
 * @param {Object} [options]
 * @param {number} [options.topN=5]    Max candidates to return
 * @returns {{ candidates: Array, missingTimestamps: boolean }|null}
 *
 * Each candidate: {
 *   insertionIndex: number,     // replay goes before schedule[insertionIndex]
 *   insertionLabel: string,     // e.g. "after Q43"
 *   minGap: number,             // min gap across all teams, both sides
 *   teamGaps: Object,           // per-team { before, after }
 *   isAfterBreak: boolean,      // informational: follows a 30+ min break
 * }
 */
function findReplaySlot(schedule, replayMatchNumber, { topN = 5 } = {}) {
  const replayMatchIdx = schedule.findIndex(m => m.matchNumber === replayMatchNumber);
  if (replayMatchIdx === -1) {
    throw new Error(`Match ${replayMatchNumber} not found in schedule`);
  }

  const replayTeams = schedule[replayMatchIdx].teams;
  const { breakAfterIndex, hasTimestamps } = detectBreaks(schedule);

  // insertionIndex i = replay inserted before schedule[i], after schedule[i-1]
  // Range: replayMatchIdx+1 (immediately after Q35) through schedule.length (after last match)
  const candidates = [];

  for (let i = replayMatchIdx + 1; i <= schedule.length; i++) {
    const { minGap, teamGaps } = computeMinGapAtInsertion(schedule, replayTeams, i);

    // Hard constraint: no back-to-back on either side for any team (Infinity = unconstrained)
    const isValid = Object.values(teamGaps).every(
      ({ before, after }) =>
        (before === Infinity || before > 0) && (after === Infinity || after > 0)
    );

    if (!isValid) continue;

    const isAfterBreak = breakAfterIndex.has(i);
    // "before Q44" when slot follows a break (clearer than "after Q43" across a lunch)
    // "after Q43" for mid-block insertions, "after Q50" at end of schedule
    const label = isAfterBreak
      ? `before Q${schedule[i].matchNumber}`
      : `after Q${schedule[i - 1].matchNumber}`;

    candidates.push({
      insertionIndex: i,
      insertionLabel: label,
      minGap,
      teamGaps,
      isAfterBreak,
    });
  }

  if (candidates.length === 0) return null;

  // Sort: minGap descending, insertionIndex ascending on ties
  candidates.sort((a, b) =>
    b.minGap !== a.minGap
      ? b.minGap - a.minGap
      : a.insertionIndex - b.insertionIndex
  );

  return {
    candidates: candidates.slice(0, topN),
    missingTimestamps: !hasTimestamps,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  findReplaySlot,
  computeTeamGap,
  computeMinGapAtInsertion,
  detectBreaks,
};