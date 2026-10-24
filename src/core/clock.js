'use strict';
/* Trading sessions, market status and the honest rendering of "when".
 *
 * The central claim this file exists to protect: THE APPLICATION NEVER SAYS
 * "LIVE" ON ITS OWN AUTHORITY. It says what time the exchange stamped the
 * figure, and it derives a session status from windows the venue itself
 * published. At 08:00 in London the newest genuine price of a US share is
 * Friday's close, and a screen that renders that as a live price is lying
 * quietly.
 *
 * Session windows are taken from the provider's own `currentTradingPeriod`
 * wherever it is supplied, because that is the venue's answer rather than this
 * application's guess. The static table below is a fallback for sources that do
 * not publish one, and it carries NO HOLIDAY CALENDAR. Inventing a holiday
 * calendar would produce confident wrong answers on the days it was incomplete;
 * a status of "closed" derived only from weekday and clock, printed next to the
 * real exchange timestamp, is correct far more often and never misleading.
 */

/* Scoped; see the note at the head of src/core/num.js for why every file
   loaded by the interface as a plain script has to be. */
(function () {

const STATUS = {
  OPEN: 'OPEN',
  PRE: 'PRE',
  POST: 'POST',
  CLOSED: 'CLOSED',
  UNKNOWN: 'UNKNOWN'
};

/* Fallback session windows, in each venue's own local time, weekdays only.
 * Used only when a provider supplies no trading period of its own. */
const VENUES = {
  'America/New_York': { open: [9, 30], close: [16, 0], pre: [4, 0], post: [20, 0] },
  'Europe/London': { open: [8, 0], close: [16, 30] },
  'Europe/Berlin': { open: [9, 0], close: [17, 30] },
  'Europe/Paris': { open: [9, 0], close: [17, 30] },
  'Asia/Tokyo': { open: [9, 0], close: [15, 30] },
  'Asia/Hong_Kong': { open: [9, 30], close: [16, 0] },
  'Asia/Kolkata': { open: [9, 15], close: [15, 30] },
  'Australia/Sydney': { open: [10, 0], close: [16, 0] },
  'America/Toronto': { open: [9, 30], close: [16, 0] }
};

/* Read a venue's wall-clock time without mutating anything or depending on the
   machine's own zone. Intl is the only correct way to do this in plain Node. */
function partsIn(timeZone, at) {
  const date = new Date(at == null ? Date.now() : at);
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (e) {
    return null;   // an unrecognised zone must not throw into a render
  }
  const found = Object.create(null);
  formatter.formatToParts(date).forEach(part => { found[part.type] = part.value; });
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekdays[found.weekday],
    hour: Number(found.hour),
    minute: Number(found.minute),
    minutes: Number(found.hour) * 60 + Number(found.minute),
    date: found.year + '-' + found.month + '-' + found.day
  };
}

/* Normalise whatever the provider gave us into one session shape.
 *
 * `periods` is the provider's currentTradingPeriod block when present. Each
 * window is an epoch range in seconds, which is unambiguous and needs no zone
 * arithmetic at all — the reason it is preferred over the table. */
function sessionFrom(meta) {
  const m = meta || {};
  const tz = m.exchangeTimezoneName || m.timezone || null;
  const periods = m.currentTradingPeriod || null;

  const window = block => {
    if (!block || typeof block.start !== 'number' || typeof block.end !== 'number') return null;
    return { start: block.start * 1000, end: block.end * 1000 };
  };

  return {
    tz,
    exchange: m.exchangeName || null,
    exchangeName: m.fullExchangeName || m.exchangeName || null,
    pre: periods ? window(periods.pre) : null,
    regular: periods ? window(periods.regular) : null,
    post: periods ? window(periods.post) : null,
    hasExtended: m.hasPrePostMarketData === true,
    /* Set by the market layer for instruments that never close. */
    continuous: false
  };
}

function within(range, at) {
  return !!range && at >= range.start && at < range.end;
}

/* Status from the provider's published windows if we have them, from the venue
   table if we do not, and UNKNOWN when we have neither. UNKNOWN is a real and
   frequently correct answer; guessing OPEN is never one. */
function statusAt(session, at) {
  const now = at == null ? Date.now() : at;
  const s = session || {};

  if (s.continuous) return STATUS.OPEN;

  if (s.regular || s.pre || s.post) {
    if (within(s.regular, now)) return STATUS.OPEN;
    if (within(s.pre, now)) return STATUS.PRE;
    if (within(s.post, now)) return STATUS.POST;
    return STATUS.CLOSED;
  }

  const venue = s.tz && VENUES[s.tz];
  if (!venue) return STATUS.UNKNOWN;

  const here = partsIn(s.tz, now);
  if (!here) return STATUS.UNKNOWN;
  if (here.weekday === 0 || here.weekday === 6) return STATUS.CLOSED;

  const mins = ([h, m]) => h * 60 + m;
  if (here.minutes >= mins(venue.open) && here.minutes < mins(venue.close)) return STATUS.OPEN;
  if (venue.pre && here.minutes >= mins(venue.pre) && here.minutes < mins(venue.open)) return STATUS.PRE;
  if (venue.post && here.minutes >= mins(venue.close) && here.minutes < mins(venue.post)) return STATUS.POST;
  return STATUS.CLOSED;
}

const STATUS_TEXT = {
  OPEN: 'Market open',
  PRE: 'Pre-market',
  POST: 'After hours',
  CLOSED: 'Market closed',
  UNKNOWN: 'Session unknown'
};

function describe(status) {
  return STATUS_TEXT[status] || STATUS_TEXT.UNKNOWN;
}

/* Foreign exchange runs continuously from Sunday evening to Friday evening in
   New York, overlapping four regional centres. These windows are the published
   market convention rather than one venue's schedule, which is why they are
   named here rather than fetched. */
const FX_CENTRES = [
  { name: 'Sydney', tz: 'Australia/Sydney', open: [7, 0], close: [16, 0] },
  { name: 'Tokyo', tz: 'Asia/Tokyo', open: [9, 0], close: [18, 0] },
  { name: 'London', tz: 'Europe/London', open: [8, 0], close: [17, 0] },
  { name: 'New York', tz: 'America/New_York', open: [8, 0], close: [17, 0] }
];

function fxCentres(at) {
  const now = at == null ? Date.now() : at;
  return FX_CENTRES.map(centre => {
    const here = partsIn(centre.tz, now);
    const mins = ([h, m]) => h * 60 + m;
    const weekend = !here || here.weekday === 0 || here.weekday === 6;
    const open = !weekend && here.minutes >= mins(centre.open) && here.minutes < mins(centre.close);
    return {
      name: centre.name,
      tz: centre.tz,
      open,
      localTime: here ? String(here.hour).padStart(2, '0') + ':' + String(here.minute).padStart(2, '0') : null
    };
  });
}

/* The currency market itself: closed from Friday evening in New York until
   Sunday evening. Derived from New York's weekday and clock, because that is
   how the convention is defined. */
function fxOpen(at) {
  const here = partsIn('America/New_York', at);
  if (!here) return false;
  if (here.weekday === 6) return false;
  if (here.weekday === 0) return here.minutes >= 17 * 60;
  if (here.weekday === 5) return here.minutes < 17 * 60;
  return true;
}

/* How a timestamp is written next to a figure.
 *
 * Same day shows a clock; any earlier day shows the day as well, because
 * "16:12" beside a price that is three days old is the exact failure this
 * whole file exists to prevent. */
function asOf(ms, timeZone) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const zone = timeZone || undefined;

  let sameDay = false;
  try {
    const day = d => new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    sameDay = day(new Date(n)) === day(new Date());
  } catch (e) {
    sameDay = false;
  }

  try {
    if (sameDay) {
      return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(n));
    }
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(n));
  } catch (e) {
    return new Date(n).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/* Elapsed time in words, for freshness badges. */
function since(ms, now) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const gap = Math.max(0, (now == null ? Date.now() : now) - n);
  const seconds = Math.round(gap / 1000);
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.round(hours / 24);
  return days + 'd ago';
}

const API = {
  STATUS, VENUES, FX_CENTRES,
  partsIn, sessionFrom, statusAt, describe,
  fxCentres, fxOpen, asOf, since
};

/* Dual-mode; see the note at the foot of src/core/num.js. The interface needs
   asOf and since for every timestamp it renders, and those must agree exactly
   with what the main process computed. */
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') { window.T = window.T || {}; window.T.clock = API; }

}());
