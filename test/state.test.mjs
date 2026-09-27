// The position algebra, checked against paper.
//
// Every expected value below was written by hand from the two recurrences in js/core/state.js's
// header comment, using a concrete candidate list and counting contradictions the slow way. The
// arithmetic is spelled out in the comments so a reviewer can redo it with a pencil without
// running anything. Nothing here reads an expectation off the implementation: `answer()` is the
// thing under test, not the thing that supplies the answer.

import { test, ok, eq, throws, run } from '../tools/harness.mjs';
import {
  fresh, total, liesLeft, validateQuestion, answer, realizable, questions, questionCount,
  encode, key, formatState, describeState, dominates, moved, K_MAX, N_MAX, Q_MAX,
} from '../js/core/state.js';

// ---- the vocabulary -------------------------------------------------------
test('fresh(n,k) puts everything in slot 0 and has k+1 slots', () => {
  eq(fresh(5, 0), [5], 'no lies allowed: one slot');
  eq(fresh(5, 1), [5, 0], 'one lie: two slots');
  eq(fresh(4, 3), [4, 0, 0, 0], 'three lies: four slots');
  eq(total(fresh(9, 2)), 9, 'Σa is the number of surviving candidates');
  eq(liesLeft(fresh(9, 2)), 2, 'k = slots - 1');
});

test('the shipped caps are the caps the docs quote', () => {
  eq([K_MAX, N_MAX, Q_MAX], [3, 40, 14], 'k ≤ 3, 40 cells, q ≤ 14');
});

// ---- the YES recurrence: b_j = y_j + (a_{j-1} - y_{j-1}) -------------------
// WORKED BY HAND — two candidates {1,2}, budget k=1, light candidate 1 only:
//   a = (2, 0): both candidates contradicted zero times.
//   y = (1, 0): one of the two clean candidates is lit.
//   Answer YES ("it is lit"):
//     the lit one agreed with the truth-of-its-own-case → still 0 contradictions → b_0 = y_0 = 1
//     the dark one contradicted the answer → it moves 0 → 1          → b_1 = n_0 = a_0 - y_0 = 1
//     b = (1, 1). Read out loud: candidate 1 is clean, candidate 2 is one contradiction deep.
test('YES branch, hand-worked on two candidates', () => {
  eq(answer([2, 0], [1, 0]).yes, [1, 1], 'lit stays, dark moves up one');
});

// ---- the NO recurrence: c_j = (a_j - y_j) + y_{j-1} ------------------------
// Same position, same question, answer NO:
//   the dark candidate (2) agreed → stays at 0 → c_0 = n_0 = 1
//   the lit candidate (1) contradicted → moves 0 → 1 → c_1 = n_1 + y_0 = 0 + 1 = 1
//   c = (1, 1) — identical to the YES branch HERE only because the question lit exactly one of
//   two symmetric candidates. That symmetry is the reason both rows are (1,1) and not a bug.
test('NO branch is the mirror image, same two-candidate example', () => {
  eq(answer([2, 0], [1, 0]).no, [1, 1], 'dark stays, lit moves up one');
});

// ---- three candidates, one lit: the branches are NOT symmetric -------------
// a = (3, 0), y = (1, 0) — light exactly one of three.
//   YES: the lit one stays clean → b_0 = 1; the two dark ones each gain one → b_1 = 2. b = (1, 2).
//   NO : the two dark ones stay clean → c_0 = 2; the lit one gains one → c_1 = 1. c = (2, 1).
// This pair is the whole reason the game is interesting: one answer leaves 1 candidate with a lie
// already against it, the other leaves 2. Volume.test turns this into the 15-vs-16 headline.
test('three candidates, one lit: (1,2) and (2,1) by hand', () => {
  const { yes, no } = answer([3, 0], [1, 0]);
  eq(yes, [1, 2], 'YES leaves the lit one clean and moves the two dark ones up');
  eq(no, [2, 1], 'NO leaves the two dark ones clean and moves the lit one up');
  eq([total(yes), total(no)], [3, 3], 'nobody died: k = 1 still allows one contradiction each');
});

// ---- k = 2, a mixed slot ---------------------------------------------------
// a = (2, 1, 0): A, B clean; C contradicted once. y = (1, 1, 0): light A and C.
//   YES: A lit → stays 0 → b_0 = y_0 = 1.
//        B dark from slot 0 → 1; C lit from slot 1 → stays 1 → b_1 = y_1 + (a_0 - y_0) = 1 + 1 = 2.
//        nothing moves into slot 2: b_2 = y_2 + (a_1 - y_1) = 0 + 0 = 0. → b = (1, 2, 0)
//   NO : B dark → stays clean → c_0 = a_0 - y_0 = 1.
//        A lit, contradicted 0 → 1 → c_1 = (a_1 - y_1) + y_0 = 0 + 1 = 1.
//        C lit, contradicted 1 → 2 → c_2 = (a_2 - y_2) + y_1 = 0 + 1 = 1. → c = (1, 1, 1)
test('k=2 recurrences, hand-worked on {A clean, B clean, C already contradicted}', () => {
  const { yes, no } = answer([2, 1, 0], [1, 1, 0]);
  eq(yes, [1, 2, 0], 'lit A stays clean; dark B and lit C both sit in slot 1');
  eq(no, [1, 1, 1], 'B clean, A at 1, C pushed to 2');
});

// ---- the budget really is a wall: a candidate at k leaves on its next lie --
// a = (1, 0, 1), k = 2: A clean, C already contradicted twice (no lies left). Light both, y=(1,0,1).
//   NO: A moves 0 → 1; C would move 2 → 3, which is > k, so C is no longer a possible secret and
//       simply vanishes from the vector: c_0 = 0, c_1 = 1, c_2 = 0. Σ drops 2 → 1.
test('a candidate that would exceed the budget leaves the vector (Σ can shrink)', () => {
  const { yes, no } = answer([1, 0, 1], [1, 0, 1]);
  eq(yes, [1, 0, 1], 'YES is consistent for both, nothing moves');
  eq(no, [0, 1, 0], 'C would need its 3rd lie: it is gone, Σ 2 → 1');
  eq([total(yes), total(no)], [2, 1], 'exactly the shrink the bookkeeping must not hide');
});

// ---- realizability is the witness, by definition ---------------------------
// A branch with Σ = 0 is a set of answers consistent with NO number ≤ k lies. Hand case:
// a = (0, 1), k = 1, y = (0, 1): the only survivor C already used its one lie and it is lit.
//   NO contradicts it a second time → (0, 0): unrealizable, and the adversary may never say it.
test('realizable() is exactly Σ ≥ 1, and the all-lit contradiction is Σ = 0', () => {
  const { yes, no } = answer([0, 1], [0, 1]);
  eq(yes, [0, 1], 'truth keeps C alive');
  eq(no, [0, 0], 'the lie would need a second contradiction C has no budget for');
  eq([realizable(yes), realizable(no)], [true, false], 'so only one branch is a position at all');
  eq(realizable([0, 0, 0]), false, 'the empty vector is never realizable');
  eq(realizable([0, 0, 1]), true, 'one survivor is enough');
});

test('answer() hands back BOTH branches, so a caller can check each side', () => {
  const r = answer([4, 0], [2, 0]);
  eq(Object.keys(r).sort(), ['no', 'yes'], 'exactly two keys');
  eq(r.yes, [2, 2], 'b_0 = y_0 = 2; b_1 = y_1 + (a_0 - y_0) = 0 + 2');
  eq(r.no, [2, 2], 'the same numbers here because the split is symmetric: 2 lit, 2 dark');
});

// ---- question legality -----------------------------------------------------
test('validateQuestion names the exact complaint', () => {
  eq(validateQuestion([2, 1], [1, 1]), null, 'inside the slots: legal');
  eq(validateQuestion([2, 1], [2, 1]), null, 'all lit is legal too');
  eq(validateQuestion([2, 1], [0, 0]), null, 'nothing lit is legal (an empty question costs a lie)');
  ok(/等长/.test(validateQuestion([2, 1], [1])), 'wrong length is its own message');
  ok(/y_1 超出/.test(validateQuestion([2, 1], [2, 2])), 'more lit than present, slot 1');
  ok(/a_0 非法|权重/.test(validateQuestion([2.5, 1], [0, 1])), 'non-integer weight');
  ok(/超出/.test(validateQuestion([2, 1], [2, -1])), 'negative count');
});

test('answer() throws on an illegal question instead of guessing', () => {
  throws(() => answer([2, 0], [3, 0]), /超出/, 'cannot light 3 of 2');
  throws(() => answer([2, 0], [1]), /等长/, 'a question must name every slot');
});

// ---- the question space ----------------------------------------------------
test('questionCount(a) = Π (a_i + 1) and questions() enumerates exactly that many', () => {
  eq(questionCount([2, 1]), 3 * 2, 'slot 0 picks 0..2, slot 1 picks 0..1');
  eq(questionCount([0, 0]), 1, 'the only question is (0,0)');
  eq(questionCount([1, 1, 1]), 8, '2*2*2');
  const seen = [...questions([2, 1])];
  eq(seen.length, questionCount([2, 1]), 'the generator and the count agree');
  eq(seen[0], [0, 0], 'lexicographic, starting at "light nothing"');
  eq(seen[seen.length - 1], [2, 1], 'ending at "light everything"');
  eq(seen.map((y) => y.join(',')).join(' '),
    '0,0 0,1 1,0 1,1 2,0 2,1', 'the fixed visit order the champion depends on');
  for (const y of seen) ok(y.every((v, i) => v >= 0 && v <= [2, 1][i]), 'every y sits in its slot');
});

test('every enumerated question has two branches, each holding no more candidates than a', () => {
  for (const y of questions([3, 1])) {
    const { yes, no } = answer([3, 1], y);
    ok(total(yes) <= 4, 'nobody is invented: Σb ≤ Σa');
    ok(total(no) <= 4, 'same on the other side');
    // Σyes + Σno = Σa + (candidates that moved right without dying) − (candidates that died),
    // computed by hand for this vector: with k = 1 a move out of slot 1 dies, so the sum of the
    // two branch sizes is 2·Σa − (weight pushed out of the last slot) ≤ 8.
    ok(total(yes) + total(no) <= 2 * total([3, 1]), 'the two branches together cannot double');
  }
});

// ---- the difficulty order --------------------------------------------------
// dominates(a, b) = "a is at least as hard as b": every prefix of b holds no more weight.
// Fewer candidates is easier, and pushing a candidate RIGHT (more contradictions already
// against it) is easier, because it has fewer lies left to spend.
test('dominates: fewer candidates and rightward weight both make life easier', () => {
  eq(dominates([2, 0], [1, 0]), true, 'one fewer candidate');
  eq(dominates([1, 0], [2, 0]), false, 'and not the other way');
  eq(dominates([2, 0], [1, 1]), true, 'same Σ, but the survivor moved right: easier for the player');
  eq(dominates([1, 1], [2, 0]), false, 'leftward weight is harder, so no');
  eq(dominates([2, 0, 0], [1, 1, 0]), true, 'prefix sums: 1 ≤ 2 then 2 ≤ 2');
  eq(dominates([2, 0, 0], [0, 2, 0]), true, 'prefix sums 0 ≤ 2, 2 ≤ 2: both candidates one lie deep is easier than both clean');
  eq(dominates([1, 1], [1, 1]), true, 'reflexive');
  eq(dominates([2, 0], [1]), false, 'different k is not comparable');
});

test('moved() shifts weight between slots without touching Σ', () => {
  eq(moved([2, 0], 0, 1, 1), [1, 1], 'one candidate pushed up one level');
  eq(moved([2, 0, 0], 0, 2, 2), [0, 0, 2], 'two at once, past one slot');
  eq(total(moved([3, 1], 0, 1, 2)), 4, 'Σ unchanged');
});

// ---- memo keys -------------------------------------------------------------
test('encode() separates both the vector and the depth', () => {
  eq(key([3, 1], 4), encode([3, 1], 4), 'key is encode');
  ok(encode([3, 1], 4) !== encode([3, 1], 5), 'different q, different key');
  ok(encode([3, 1], 4) !== encode([1, 3], 4), 'different vector, different key');
  ok(encode([3], 4) !== encode([3, 0], 4), 'different k (slot count), different key');
  const seen = new Set();
  let expected = 0;
  for (let n = 0; n <= 8; n++) {
    for (let i = 0; i <= n; i++) {
      for (let q = 0; q <= 6; q++) { seen.add(encode([i, n - i], q)); expected++; }
    }
  }
  // Σ(n+1) for n = 0..8 is 45 vectors, times 7 depths = 315 distinct keys demanded.
  eq([seen.size, expected], [315, 315], 'no collisions over every (a,q) with Σa ≤ 8, q ≤ 6');
});

// ---- screen strings --------------------------------------------------------
test('formatState and describeState print what the drawer claims', () => {
  eq(formatState([3, 1]), '(3 | 1)', 'the drawer form');
  eq(formatState([16, 0, 0]), '(16 | 0 | 0)', 'k = 2 gets three bars');
  eq(describeState([3, 1]), '3×0谎 + 1×1谎', 'slot label = how many contradictions');
  eq(describeState([0, 2, 0]), '2×1谎', 'empty slots are not printed');
  eq(describeState([0, 0]), '空', 'the empty position says so out loud');
});

run();
