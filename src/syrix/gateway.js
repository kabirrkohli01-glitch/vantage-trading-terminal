'use strict';
/* The link to the research assistant's model gateway.
 *
 * THIS PROJECT HOLDS A DEVICE TOKEN AND NOTHING ELSE. No provider key is copied
 * here from any other project, and none is stored. The token is issued by the
 * gateway in exchange for a pairing code, is scoped to this installation, and
 * can be revoked without touching anything else. The pairing code is typed in
 * once and is not kept.
 *
 * The gateway enforces a request allowance per device. Rather than discovering
 * that by being refused mid-answer, the allowance is tracked here and a request
 * that would exceed it is declined locally with a plain explanation — a
 * refusal the operator can understand beats an opaque failure halfway through
 * a sentence.
 */

const { id: makeId } = require('../core/util');

/* The deployment address is configuration, not source: an installation names
   its own gateway through SYRIX_GATEWAY_URL. */
const GATEWAY = process.env.SYRIX_GATEWAY_URL || '';

/* The gateway maps these onto model tiers. Anything it does not recognise falls
   through to the smallest model on the rack, so the two it does recognise are
   named here as constants rather than passed through as free text. */
const MODE = {
  /* Conversation, research, anything that has to reason. */
  CHAT: 'zenith',
  /* Short summaries where latency matters more than depth. */
  BRIEF: 'spark'
};

/* Published per-device allowance. Tracked locally so the limit is explained
   before it is hit rather than reported as a failure. */
const LIMITS = { perMinute: 20, perDay: 400 };

const KEY = 'syrix-device';

/* What a round throws when the operator asked for it to stop, rather than
   when anything actually went wrong. Marked with `.stopped` rather than a
   `kind` like the unpaired error, because callers need to tell it apart from
   a real failure at a glance without matching on English text. */
function stopError() {
  const error = new Error('Stopped.');
  error.stopped = true;
  return error;
}

class Gateway {
  constructor(options) {
    const opts = options || {};
    this.store = opts.store;
    this.audit = opts.audit || null;
    this.endpoint = opts.endpoint || GATEWAY;
    this.recent = [];        // request timestamps, for the per-minute window
    this.dayCount = 0;
    this.dayKey = null;
  }

  device() {
    return this.store.doc(KEY, null);
  }

  connected() {
    const device = this.device();
    return !!(device && device.token);
  }

  status() {
    const device = this.device();
    this.rollDay();
    return {
      connected: !!(device && device.token),
      deviceId: device ? device.deviceId : null,
      pairedAt: device ? device.pairedAt : null,
      endpoint: this.endpoint,
      /* The token itself is never returned across the bridge. */
      usage: {
        lastMinute: this.recent.filter(at => Date.now() - at < 60000).length,
        today: this.dayCount,
        perMinute: LIMITS.perMinute,
        perDay: LIMITS.perDay
      }
    };
  }

  /* Exchange a pairing code for a token belonging to this installation. */
  async pair(code, label) {
    const pairing = String(code || '').trim();
    if (!pairing) throw new Error('A pairing code is needed to connect.');

    const response = await fetch(this.endpoint + '/v1/device/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: pairing,
        deviceId: makeId('vantage'),
        label: label || 'Terminal on this machine'
      })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token) {
      throw new Error(body.error === 'bad_code'
        ? 'That pairing code was not accepted.'
        : 'The gateway refused to pair: ' + (body.error || response.status));
    }

    const device = {
      token: body.token,
      deviceId: body.deviceId,
      pairedAt: Date.now(),
      endpoint: this.endpoint
    };
    this.store.putDoc(KEY, device);
    /* The pairing code is deliberately not stored anywhere. */
    if (this.audit) this.audit.write('syrix.paired', { deviceId: device.deviceId });
    return { connected: true, deviceId: device.deviceId };
  }

  disconnect() {
    this.store.putDoc(KEY, null);
    if (this.audit) this.audit.write('syrix.disconnected', {});
    return { connected: false };
  }

  rollDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dayKey !== today) { this.dayKey = today; this.dayCount = 0; }
  }

  /* Refuse locally rather than be refused remotely, and say which limit and
     when it clears. */
  checkAllowance() {
    this.rollDay();
    const now = Date.now();
    this.recent = this.recent.filter(at => now - at < 60000);

    if (this.recent.length >= LIMITS.perMinute) {
      const oldest = this.recent[0];
      const seconds = Math.ceil((60000 - (now - oldest)) / 1000);
      throw new Error('That is ' + LIMITS.perMinute + ' requests in a minute, which is the gateway\'s limit. ' +
        'Try again in ' + seconds + ' second' + (seconds === 1 ? '' : 's') + '.');
    }
    if (this.dayCount >= LIMITS.perDay) {
      throw new Error('That is ' + LIMITS.perDay + ' requests today, which is the gateway\'s daily allowance. ' +
        'It resets at midnight.');
    }
  }

  /* One round with the model.
   *
   * `onToken` receives text as it arrives. The stream is read frame by frame
   * rather than buffered, so a long answer appears as it is written instead of
   * all at once after a silence. */
  async chat(request) {
    const device = this.device();
    if (!device || !device.token) {
      const error = new Error('The research assistant is not connected. Pair it in settings.');
      error.kind = 'unpaired';
      throw error;
    }

    this.checkAllowance();
    this.recent.push(Date.now());
    this.dayCount++;

    const payload = {
      mode: request.mode === MODE.BRIEF ? MODE.BRIEF : MODE.CHAT,
      messages: request.messages,
      stream: request.onToken ? true : false,
      temperature: request.temperature == null ? 0.4 : request.temperature,
      maxTokens: request.maxTokens || 1400
    };
    if (request.tools && request.tools.length) payload.tools = request.tools;
    if (request.media && request.media.length) payload.media = request.media;

    /* A round the operator asked to stop and a round that simply took too
       long both end the same request the same way — aborting it — but must
       not read the same afterwards. `stoppedByOperator` is checked wherever
       the abort could have come from either, so a stop reads as a stop and a
       timeout still reads as a timeout. */
    const controller = new AbortController();
    const stoppedByOperator = () => !!(request.signal && request.signal.aborted);
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const timer = setTimeout(() => controller.abort(), request.timeout || 120000);

    let response;
    try {
      response = await fetch(this.endpoint + '/v1/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Syrix-Token': device.token,
          'X-Syrix-Device': device.deviceId
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError' && stoppedByOperator()) throw stopError();
      throw new Error(err.name === 'AbortError'
        ? 'The assistant did not answer in time.'
        : 'Could not reach the assistant.');
    }

    if (!response.ok) {
      clearTimeout(timer);
      const body = await response.text().catch(() => '');
      if (response.status === 401) {
        throw new Error('The gateway no longer recognises this device. Pair it again in settings.');
      }
      if (response.status === 429) {
        throw new Error('The gateway is rate limiting this device. Wait a moment and try again.');
      }
      throw new Error('The assistant answered ' + response.status + '. ' + body.slice(0, 200));
    }

    if (!payload.stream) {
      clearTimeout(timer);
      const body = await response.json();
      return { text: body.text || '', toolCalls: body.toolCalls || [] };
    }

    let result;
    try {
      result = await this.readStream(response, request.onToken);
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        if (stoppedByOperator()) throw stopError();
        throw new Error('The assistant did not answer in time.');
      }
      throw err;
    }
    clearTimeout(timer);
    return result;
  }

  /* The gateway speaks a reduced event dialect: token, tool_call, error, done.
   *
   * Stopped partway through — the operator asked to, or the round timed out
   * mid-stream — the read throws rather than resolves, since the browser
   * rejects a pending read the instant its controller aborts. What had
   * already arrived is not lost: `onToken` was already called with it, so
   * the caller has it independently of whatever this returns. */
  async readStream(response, onToken) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const toolCalls = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      /* The last piece is a partial frame; it stays in the buffer until the
         rest of it arrives. Treating it as complete truncates a token, and on a
         multi-byte character it truncates mid-letter. */
      buffer = frames.pop();

      for (const frame of frames) {
        const line = frame.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let event;
        try { event = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }

        if (event.type === 'token' && event.text) {
          text += event.text;
          if (onToken) onToken(text, event.text);
        } else if (event.type === 'tool_call') {
          toolCalls.push({ id: event.id, name: event.name, args: event.args });
        } else if (event.type === 'error') {
          throw new Error(event.message || 'The assistant reported an error.');
        }
      }
    }

    return { text, toolCalls };
  }
}

module.exports = { Gateway, MODE, LIMITS, GATEWAY };
