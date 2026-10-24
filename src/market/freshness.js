'use strict';
/* The freshness state machine.
 *
 * Every figure in this application carries one of these states, and the state
 * is derived rather than asserted. There is no code path that sets LIVE because
 * a request happened to succeed.
 *
 *   LIVE        the venue stamped this within the expected cadence, and the
 *               provider has declared real-time coverage for this venue
 *   DELAYED     the provider publishes a delay, or has not told us there is
 *               none — an undeclared delay is still a delay
 *   CLOSED      the session is not running; an old last price is correct here
 *   HISTORICAL  a past bar, requested as history, not a current figure
 *   STALE       the session is running and nothing has arrived when it should
 *   UNKNOWN     no timestamp, or a timestamp that cannot be trusted
 *
 * The default is not LIVE. A provider that says nothing about its own latency
 * lands on DELAYED with an unknown interval, which the badge renders honestly.
 * Getting this backwards — treating silence as real-time — is the single
 * failure this file exists to prevent.
 */

const clock = require('../core/clock');

const STATE = {
  LIVE: 'LIVE',
  DELAYED: 'DELAYED',
  CLOSED: 'CLOSED',
  HISTORICAL: 'HISTORICAL',
  STALE: 'STALE',
  UNKNOWN: 'UNKNOWN'
};

/* Ordered worst-first. The status bar shows the worst state among everything on
   screen, so one silently dead feed cannot hide behind nine healthy ones. */
const SEVERITY = [STATE.UNKNOWN, STATE.STALE, STATE.DELAYED, STATE.CLOSED, STATE.HISTORICAL, STATE.LIVE];

/* A venue timestamp ahead of this machine's clock by more than this is not a
   fast feed, it is a clock disagreement, and a figure dated in the future
   cannot be aged. Half a minute absorbs ordinary drift. */
const SKEW_TOLERANCE_MS = 30 * 1000;

/* How long past the expected cadence a figure may go before the session is
   judged to have stopped delivering. Three intervals allows one missed poll and
   one retry without crying wolf. */
const STALE_FACTOR = 3;
const MIN_STALE_MS = 90 * 1000;

/* The threshold for a source that has not disclosed its latency. Long enough
   that an undisclosed delay is not mistaken for a dead feed; short enough that
   a genuinely dead feed is still caught within the hour. */
const UNDECLARED_STALE_MS = 45 * 60 * 1000;

function assess(input) {
  const it = input || {};
  const now = it.now == null ? Date.now() : it.now;
  const at = Number(it.at);
  const cadence = Number(it.cadence) || 60000;

  /* Explicitly requested history is never assessed for staleness. A bar from
     March is supposed to be old. */
  if (it.historical) {
    return finish(STATE.HISTORICAL, { at, ageMs: Number.isFinite(at) ? now - at : null, reason: 'Past data.' });
  }

  if (!Number.isFinite(at) || at <= 0) {
    return finish(STATE.UNKNOWN, {
      at: null, ageMs: null,
      reason: 'The source supplied no timestamp for this figure.'
    });
  }

  if (at - now > SKEW_TOLERANCE_MS) {
    return finish(STATE.UNKNOWN, {
      at, ageMs: null, suspect: true,
      reason: 'The source timestamped this ahead of this machine\'s clock.'
    });
  }

  const ageMs = Math.max(0, now - at);
  const session = it.session || null;
  const continuous = it.continuous === true || (session && session.continuous === true);
  const sessionStatus = continuous ? clock.STATUS.OPEN : clock.statusAt(session, now);

  /* Outside a running session an old figure is the correct figure.
   *
   * EXTENDED HOURS DO NOT COUNT AS RUNNING FOR A REGULAR-SESSION FIGURE, and
   * getting this wrong produced a real false alarm: the regular market time a
   * venue publishes is frozen at the closing bell by definition, so once
   * after-hours trading began, the gap grew by the hour against a session this
   * layer believed was live, and three perfectly healthy US equities were
   * badged "not updating" at seven in the evening.
   *
   * A figure stamped in extended trading is a different figure with its own
   * timestamp; a caller assessing one says so, and only then does the pre- or
   * post-market window count as running. */
  const extendedRunning = it.extendedFigure === true && session && session.hasExtended &&
    (sessionStatus === clock.STATUS.PRE || sessionStatus === clock.STATUS.POST);
  const running = sessionStatus === clock.STATUS.OPEN || extendedRunning;

  if (!running) {
    if (sessionStatus === clock.STATUS.UNKNOWN) {
      /* No session information at all. The age is still measurable, so a
         figure that is hours old is reported as unknown rather than passed off
         as current. */
      return finish(STATE.UNKNOWN, {
        at, ageMs,
        reason: 'This venue\'s trading hours are not known, so this figure cannot be confirmed as current.'
      });
    }
    return finish(STATE.CLOSED, {
      at, ageMs, sessionStatus,
      reason: clock.describe(sessionStatus) + '. This is the last price of the session.'
    });
  }

  const declaredDelay = it.delaySeconds == null ? null : Number(it.delaySeconds);
  const delayMs = declaredDelay === null ? 0 : declaredDelay * 1000;

  /* HOW LONG IS TOO LONG DEPENDS ON WHETHER THE DELAY IS KNOWN.
   *
   * When a provider declares its latency, an overdue figure really is overdue
   * and a tight threshold is correct. When it declares nothing, a gap of
   * several minutes is indistinguishable from an undisclosed delay — thinly
   * traded futures and bond yield indices routinely go ten minutes between
   * prints on a feed that is working perfectly. Calling those stale marks
   * healthy data as broken, which trains the operator to ignore the badge that
   * matters. An undeclared feed therefore gets a much longer rope and is
   * reported as delayed until the gap is long enough to mean something. */
  const staleAfter = declaredDelay === null
    ? UNDECLARED_STALE_MS
    : Math.max(cadence * STALE_FACTOR, MIN_STALE_MS) + delayMs;

  if (ageMs > staleAfter) {
    return finish(STATE.STALE, {
      at, ageMs, sessionStatus, delaySeconds: declaredDelay,
      reason: 'The session is running but nothing new has arrived for ' + clock.since(at, now) + '.'
    });
  }

  /* Real-time has to be claimed by the adapter for this specific venue, and
     the claim has to be accompanied by a zero delay. Anything less is DELAYED. */
  if (it.realtime === true && (declaredDelay === null || declaredDelay === 0)) {
    return finish(STATE.LIVE, { at, ageMs, sessionStatus, delaySeconds: 0, reason: 'Real-time from the venue.' });
  }

  if (declaredDelay !== null && declaredDelay > 0) {
    return finish(STATE.DELAYED, {
      at, ageMs, sessionStatus, delaySeconds: declaredDelay,
      reason: 'This source publishes prices ' + minutes(declaredDelay) + ' behind the venue.'
    });
  }

  return finish(STATE.DELAYED, {
    at, ageMs, sessionStatus, delaySeconds: null,
    reason: 'This source has not stated whether its prices are real-time, so they are treated as delayed.'
  });
}

function minutes(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return s + ' seconds';
  const m = Math.round(s / 60);
  return m + (m === 1 ? ' minute' : ' minutes');
}

const LABELS = {
  LIVE: 'Live',
  CLOSED: 'Closed',
  HISTORICAL: 'Historical',
  STALE: 'Not updating',
  UNKNOWN: 'Unverified'
};

function finish(state, extra) {
  const out = Object.assign({ state, at: null, ageMs: null, delaySeconds: null, suspect: false }, extra || {});

  if (state === STATE.DELAYED) {
    out.label = out.delaySeconds == null || out.delaySeconds === 0
      ? 'Delayed'
      : 'Delayed ' + minutes(out.delaySeconds);
  } else {
    out.label = LABELS[state] || 'Unverified';
  }

  /* The timestamp travels with the state so a badge never has to be rendered
     without the figure that justifies it. */
  out.asOf = out.at ? clock.asOf(out.at, extra && extra.tz) : '';
  out.age = out.at ? clock.since(out.at) : null;
  return out;
}

/* The worst state among many. Used by the status bar and by any panel showing
   more than one instrument. */
function worst(states) {
  const seen = (states || []).filter(Boolean).map(s => (typeof s === 'string' ? s : s.state));
  if (!seen.length) return STATE.UNKNOWN;
  for (const level of SEVERITY) {
    if (seen.indexOf(level) !== -1) return level;
  }
  return STATE.UNKNOWN;
}

/* Whether a state is safe to compute against.
 *
 * Analysis, alerts and simulated fills all consult this. A figure that is
 * unverified or has stopped updating may still be displayed — with its badge —
 * but must not silently become an input to a number the operator will act on. */
function trustworthy(state) {
  const value = typeof state === 'string' ? state : (state && state.state);
  return value === STATE.LIVE || value === STATE.DELAYED || value === STATE.CLOSED || value === STATE.HISTORICAL;
}

module.exports = {
  STATE, SEVERITY, assess, worst, trustworthy, minutes,
  STALE_FACTOR, MIN_STALE_MS, UNDECLARED_STALE_MS, SKEW_TOLERANCE_MS
};
