'use strict';
// "13" (Big 2) as played here: 2 – 4 players, 13 cards each.
//  - Ranks 3 < 4 < … < K < A < 2; suits ♦ < ♣ < ♥ < ♠ (3♦ is the lowest card).
//  - Plays: a single, a pair, three of a kind, or five cards: straight < flush
//    < full house < four of a kind (+1) < straight flush. A 2 cannot be part of
//    a straight. You beat the table with the same number of cards, higher.
//  - Whoever holds the lowest card starts the first game and must play it;
//    after that the last winner starts with anything. When everyone else
//    passes, the last player to play starts a new trick.
//  - The first to empty their hand wins the game. The others score 1 point
//    per card left; x2 with 10 or more cards, x3 with all 13.
//  - A dealt hand of 13 different ranks (A, 2 … 10, J, Q, K) wins at once.
//  - The match: everyone starts at 0. Point limit (players reaching it are out;
//    the last one in wins) or a time limit (lowest points wins; then most game
//    wins; then the tied players play one deciding game).
//  - Optional money: each player pays every player below them the difference
//    in points times the rate (tugrik per point).
//
// The PC that opened the game (the host) runs Match; the others only see
// their own cards and how many the others hold.
(function init(root) {
  const SUITS = ['♦', '♣', '♥', '♠'];
  const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
  const rank = (c) => Math.floor(c / 4); // 0 = 3 … 11 = A, 12 = 2
  const suit = (c) => c % 4;
  const name = (c) => `${RANKS[rank(c)]}${SUITS[suit(c)]}`;
  const FIVE = ['straight', 'flush', 'fullhouse', 'four', 'straightflush'];

  // What a set of cards is, or null if it is not a valid play.
  function classify(cards) {
    const cs = [...cards].sort((a, b) => a - b);
    const n = cs.length;
    if (!n || new Set(cs).size !== n || cs.some((c) => !(c >= 0 && c < 52))) return null;
    const rs = cs.map(rank);
    const same = rs.every((r) => r === rs[0]);
    if (n === 1) return { type: 'single', n, key: [cs[0]] };
    if (n === 2) return same ? { type: 'pair', n, key: [cs[1]] } : null;
    if (n === 3) return same ? { type: 'triple', n, key: [rs[0]] } : null;
    if (n !== 5) return null;
    const flush = cs.every((c) => suit(c) === suit(cs[0]));
    const straight = !rs.includes(12) && rs.every((r, i) => i === 0 || r === rs[i - 1] + 1);
    const counts = {};
    for (const r of rs) counts[r] = (counts[r] || 0) + 1;
    const groups = Object.entries(counts).map(([r, k]) => [Number(r), k]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    if (straight && flush) return { type: 'straightflush', n, cat: 4, key: [cs[4]] };
    if (groups[0][1] === 4) return { type: 'four', n, cat: 3, key: [groups[0][0]] };
    if (groups[0][1] === 3 && groups[1][1] === 2) return { type: 'fullhouse', n, cat: 2, key: [groups[0][0]] };
    if (flush) return { type: 'flush', n, cat: 1, key: [...rs].reverse().concat(suit(cs[0])) };
    if (straight) return { type: 'straight', n, cat: 0, key: [cs[4]] };
    return null;
  }

  // Does play a beat play b (same number of cards, higher)?
  function beats(a, b) {
    if (!a || !b || a.n !== b.n) return false;
    if (a.n === 5 && a.cat !== b.cat) return a.cat > b.cat;
    for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) {
      const x = a.key[i] ?? -1;
      const y = b.key[i] ?? -1;
      if (x !== y) return x > y;
    }
    return false;
  }

  // 13 different ranks: an instant win.
  const isDragon = (hand) => hand.length === 13 && new Set(hand.map(rank)).size === 13;

  // Points for the cards left in a loser's hand.
  function penalty(left) {
    if (left <= 0) return 0;
    return left * (left === 13 ? 3 : left >= 10 ? 2 : 1);
  }

  // Who pays whom: everyone pays everyone below them (difference x rate).
  function settle(totals, rate) {
    const ids = Object.keys(totals);
    const pays = [];
    const net = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const a of ids) {
      for (const b of ids) {
        const d = totals[a] - totals[b];
        if (d > 0 && rate > 0) {
          pays.push({ from: a, to: b, points: d, amount: d * rate });
          net[a] -= d * rate;
          net[b] += d * rate;
        }
      }
    }
    return { pays, net };
  }

  function mulberry(a) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Match {
    // players: [{ id, name }] in seat order.
    // opts: { end: 'limit' | 'time', limit, minutes, rate, turnTime (s, 0 = off), seed, now }
    constructor(players, opts = {}) {
      this.players = players.map((p) => ({ id: p.id, name: p.name }));
      this.end = opts.end === 'time' ? 'time' : 'limit';
      this.limit = Number(opts.limit) || 30;
      this.minutes = Number(opts.minutes) || 60;
      this.rate = Number(opts.rate) || 0;
      this.turnTime = Number(opts.turnTime) || 0;
      this.rand = mulberry(opts.seed || 1);
      this.started = opts.now || Date.now();
      this.totals = Object.fromEntries(this.players.map((p) => [p.id, 0]));
      this.wins = Object.fromEntries(this.players.map((p) => [p.id, 0]));
      this.out = new Set(); // eliminated (point limit)
      this.gone = new Set(); // left the match
      this.round = 0;
      this.lastWinner = null;
      this.history = []; // [{ round, winner, points: { id: n }, dragon }]
      this.tiebreak = null; // ids playing a deciding game
      this.over = null; // { winner, reason }
      this.events = [];
      this.game = null;
    }

    active() {
      const ids = this.tiebreak || this.players.map((p) => p.id);
      return ids.filter((id) => !this.out.has(id) && !this.gone.has(id));
    }

    fx(e) { this.events.push(e); }

    // Deals a new game to the players still in.
    deal(now = Date.now()) {
      if (this.over) return;
      const seats = this.active();
      if (seats.length < 2) { this.finish(seats[0] || null, 'last'); return; }
      this.round++;
      const deck = Array.from({ length: 52 }, (_, i) => i);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const hands = {};
      seats.forEach((id, i) => { hands[id] = deck.slice(i * 13, i * 13 + 13).sort((a, b) => a - b); });
      // Who starts: the last winner if still in; otherwise the lowest card dealt (must be played).
      let lead = this.lastWinner && seats.includes(this.lastWinner) ? this.lastWinner : null;
      let mustPlay = null;
      if (!lead) {
        const lowest = Math.min(...seats.map((id) => hands[id][0]));
        lead = seats.find((id) => hands[id][0] === lowest);
        mustPlay = lowest;
      }
      this.game = {
        seats, hands, turn: lead, leader: lead, table: null, tableBy: null, passed: [], mustPlay,
        log: [], winner: null, turnStart: now, endsAt: 0,
      };
      this.fx({ e: 'deal', round: this.round, lead });
      // A dealt dragon wins at once.
      const dragon = seats.find((id) => isDragon(hands[id]));
      if (dragon) {
        this.fx({ e: 'dragon', id: dragon });
        this.endGame(dragon, now, true);
      }
    }

    // A player plays cards (or passes when cards is empty).
    play(id, cards, now = Date.now()) {
      const g = this.game;
      if (!g || g.winner || this.over || g.turn !== id) return { error: 'Not your turn' };
      const hand = g.hands[id];
      if (!cards || !cards.length) {
        if (!g.table) return { error: 'You start this trick, so you must play' };
        g.passed.push(id);
        this.fx({ e: 'pass', id });
        this.next(now);
        return { ok: true };
      }
      if (!cards.every((c) => hand.includes(c))) return { error: 'You do not have those cards' };
      const combo = classify(cards);
      if (!combo) return { error: 'That is not a valid combination' };
      if (g.mustPlay !== null && !cards.includes(g.mustPlay)) return { error: `The first play must include ${name(g.mustPlay)}` };
      if (g.table && !beats(combo, g.table)) return { error: g.table.n !== combo.n ? `Play ${g.table.n} card(s) to beat the table` : 'Your cards must be higher' };
      g.mustPlay = null;
      g.hands[id] = hand.filter((c) => !cards.includes(c));
      g.table = combo;
      g.table.cards = [...cards].sort((a, b) => a - b);
      g.tableBy = id;
      g.log.push({ id, cards: g.table.cards, type: combo.type });
      this.fx({ e: 'play', id, cards: g.table.cards, type: combo.type, left: g.hands[id].length });
      if (!g.hands[id].length) { this.endGame(id, now, false); return { ok: true }; }
      this.next(now);
      return { ok: true };
    }

    next(now) {
      const g = this.game;
      const seats = g.seats.filter((s) => !this.gone.has(s));
      let i = seats.indexOf(g.turn);
      for (let k = 0; k < seats.length; k++) {
        i = (i + 1) % seats.length;
        const s = seats[i];
        if (s === g.tableBy) {
          // Everyone else passed: the last player starts a new trick.
          g.table = null;
          g.tableBy = null;
          g.passed = [];
          g.turn = s;
          g.leader = s;
          g.turnStart = now;
          this.fx({ e: 'trick', id: s });
          return;
        }
        if (!g.passed.includes(s)) { g.turn = s; g.turnStart = now; return; }
      }
      // Only the leader is left (others passed or gone).
      g.table = null; g.tableBy = null; g.passed = []; g.turnStart = now;
    }

    endGame(winner, now, dragon) {
      const g = this.game;
      g.winner = winner;
      const points = {};
      for (const id of g.seats) {
        const p = id === winner ? 0 : penalty(g.hands[id].length);
        points[id] = p;
        if (!this.tiebreak) this.totals[id] += p;
      }
      this.wins[winner]++;
      this.lastWinner = winner;
      this.history.push({ round: this.round, winner, points, dragon: !!dragon, left: Object.fromEntries(g.seats.map((id) => [id, g.hands[id].length])) });
      this.fx({ e: 'gameOver', winner, points, dragon: !!dragon });
      g.endsAt = now;
      // A deciding game ends the match.
      if (this.tiebreak) { this.finish(winner, 'tiebreak'); return; }
      if (this.end === 'limit') {
        for (const id of this.active()) {
          if (this.totals[id] >= this.limit) { this.out.add(id); this.fx({ e: 'out', id }); }
        }
        const left = this.active();
        if (left.length <= 1) this.finish(left[0] || this.lowest(), 'limit');
      } else if (now - this.started >= this.minutes * 60000) this.timeUp();
    }

    lowest() {
      const ids = this.players.map((p) => p.id).filter((id) => !this.gone.has(id));
      return ids.sort((a, b) => this.totals[a] - this.totals[b] || this.wins[b] - this.wins[a])[0] || null;
    }

    // Time limit reached (after the current game): lowest points, then most wins, then a deciding game.
    timeUp() {
      const ids = this.players.map((p) => p.id).filter((id) => !this.gone.has(id));
      const best = Math.min(...ids.map((id) => this.totals[id]));
      let tied = ids.filter((id) => this.totals[id] === best);
      if (tied.length > 1) {
        const w = Math.max(...tied.map((id) => this.wins[id]));
        tied = tied.filter((id) => this.wins[id] === w);
      }
      if (tied.length === 1) this.finish(tied[0], 'time');
      else { this.tiebreak = tied; this.fx({ e: 'tiebreak', ids: tied }); }
    }

    finish(winner, reason) {
      if (this.over) return;
      this.over = { winner, reason, settle: settle(Object.fromEntries(this.players.map((p) => [p.id, this.totals[p.id]])), this.rate) };
      this.fx({ e: 'matchOver', winner, reason });
    }

    // Called regularly by the host: turn timer (auto-pass, or the lowest card when starting a trick).
    tick(now = Date.now()) {
      const g = this.game;
      if (!g || g.winner || this.over || !this.turnTime) return;
      if (now - g.turnStart < this.turnTime * 1000) return;
      const id = g.turn;
      if (g.table) this.play(id, [], now);
      else {
        const card = g.mustPlay !== null ? g.mustPlay : g.hands[id][0];
        this.play(id, [card], now);
      }
      this.fx({ e: 'timeout', id });
    }

    leave(id, now = Date.now()) {
      if (this.gone.has(id)) return;
      this.gone.add(id);
      const g = this.game;
      if (g && !g.winner && g.seats.includes(id)) {
        if (g.turn === id) this.next(now);
        const left = g.seats.filter((s) => !this.gone.has(s));
        if (left.length === 1) this.endGame(left[0], now, false);
      }
      if (this.active().length <= 1 && !this.over) this.finish(this.active()[0] || this.lowest(), 'left');
    }

    // What one player may see: their own cards, the others' card counts.
    view(forId, now = Date.now()) {
      const g = this.game;
      const v = {
        round: this.round, end: this.end, limit: this.limit, minutes: this.minutes, rate: this.rate, turnTime: this.turnTime,
        started: this.started, now, totals: this.totals, wins: this.wins, out: [...this.out], gone: [...this.gone],
        tiebreak: this.tiebreak, over: this.over, history: this.history.slice(-30),
        players: this.players,
      };
      if (g) {
        v.game = {
          seats: g.seats, turn: g.turn, leader: g.leader, table: g.table ? { cards: g.table.cards, type: g.table.type, by: g.tableBy } : null,
          passed: g.passed, mustPlay: g.mustPlay, winner: g.winner, turnStart: g.turnStart,
          counts: Object.fromEntries(g.seats.map((id) => [id, g.hands[id].length])),
          hand: g.hands[forId] ? [...g.hands[forId]] : null,
          // At the end of a game everyone's remaining cards are shown.
          reveal: g.winner ? Object.fromEntries(g.seats.map((id) => [id, [...g.hands[id]]])) : null,
        };
      }
      return v;
    }

    takeEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }
  }

  const Thirteen = { Match, classify, beats, penalty, settle, isDragon, rank, suit, name, RANKS, SUITS, FIVE };
  if (typeof module !== 'undefined' && module.exports) module.exports = Thirteen;
  else root.Thirteen = Thirteen;
}(typeof window !== 'undefined' ? window : globalThis));
