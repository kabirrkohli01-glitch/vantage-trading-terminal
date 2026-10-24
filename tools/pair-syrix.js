'use strict';
/* Connect this installation to the research assistant's gateway.
 *
 * WHAT THIS DOES AND DOES NOT DO. It exchanges a pairing code for a DEVICE
 * TOKEN belonging to this installation, and stores only that token. It does not
 * copy, read or store any provider key, and it does not keep the pairing code.
 * The token is scoped to this device and can be revoked on its own without
 * affecting anything else that has ever paired.
 *
 * Usage:
 *   node tools/pair-syrix.js <pairing-code>
 *   node tools/pair-syrix.js --status
 *   node tools/pair-syrix.js --disconnect
 */

const fs = require('fs');
const path = require('path');

process.env.TERMINAL_DATA_DIR = process.env.TERMINAL_DATA_DIR || path.join(__dirname, '..', 'data');

const paths = require('../src/core/paths');
const { Store } = require('../src/core/store');
const { Gateway } = require('../src/syrix/gateway');

async function main() {
  const args = process.argv.slice(2);
  const store = new Store(paths.dir('config'));
  const gateway = new Gateway({ store });

  if (args.indexOf('--status') !== -1) {
    const status = gateway.status();
    console.log(status.connected
      ? 'Connected as ' + status.deviceId + ', paired ' + new Date(status.pairedAt).toLocaleString()
      : 'Not connected.');
    console.log('Gateway: ' + status.endpoint);
    console.log('Used today: ' + status.usage.today + ' of ' + status.usage.perDay);
    return;
  }

  if (args.indexOf('--disconnect') !== -1) {
    gateway.disconnect();
    console.log('Disconnected. The device token has been removed from this installation.');
    return;
  }

  if (gateway.connected() && args.indexOf('--force') === -1) {
    console.log('Already connected as ' + gateway.status().deviceId + '. Pass --force to pair again.');
    return;
  }

  const code = args.find(a => !a.startsWith('--'));
  if (!code) {
    console.error('A pairing code is needed. Pass it as an argument.');
    process.exit(1);
  }
  if (!gateway.endpoint) {
    console.error('No gateway configured. Set SYRIX_GATEWAY_URL first.');
    process.exit(1);
  }

  try {
    const result = await gateway.pair(code, 'Terminal on this machine');
    console.log('Paired. This installation now holds its own device token.');
    console.log('Device: ' + result.deviceId);
    console.log('The pairing code was not stored.');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();
