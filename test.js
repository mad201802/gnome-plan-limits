// SPDX-License-Identifier: GPL-2.0-or-later
// gjs -m test.js
import {parseUsage, pace, fmtDuration, levelClass, notifications, HOUR, MIN} from './usage.js';

const eq = (a, b, msg) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
        throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

const reset = '2026-10-15T13:39:59.596195+00:00';
const [s, w] = parseUsage({
    five_hour: {utilization: 38.9, resets_at: reset},
    seven_day: {utilization: null, resets_at: null},
});
eq([s.key, s.pct, s.resetsAt], ['session', 38, Date.parse(reset)], 'parse session');
eq([w.key, w.pct, w.resetsAt], ['weekly', null, null], 'parse null weekly');
eq(parseUsage({}).map(l => l.pct), [null, null], 'parse missing');

const lim = {pct: 40, resetsAt: 10 * HOUR, windowMs: 5 * HOUR};
eq(pace(lim, 7.5 * HOUR), {elapsedPct: 50, ahead: false, hitAt: null}, 'pace on track');
eq(pace({...lim, pct: 80}, 7.5 * HOUR), {elapsedPct: 50, ahead: true, hitAt: 8.125 * HOUR}, 'pace ahead');
eq(pace({...lim, pct: 80}, 5.1 * HOUR).hitAt, null, 'no projection in first 5%');
eq(pace({...lim, pct: null}, 0), null, 'pace null');

eq(fmtDuration(161 * MIN), '2h 41m', 'fmt h m');
eq(fmtDuration(161 * MIN, true), '2h41m', 'fmt compact');
eq(fmtDuration((4 * 24 + 14) * HOUR + 5 * MIN, true), '4d14h', 'fmt days');
eq(fmtDuration(30_000), '1m', 'fmt rounds up');
eq(fmtDuration(-5), '0m', 'fmt negative');

eq([levelClass(74), levelClass(75), levelClass(90), levelClass(null)], ['', 'cu-warn', 'cu-crit', ''], 'levels');

const n = {};
const at = (pct, resetsAt = 10 * HOUR) => [{key: 'session', pct, resetsAt}];
eq(notifications(n, at(70), 6 * HOUR, true).length, 0, 'below threshold');
eq(notifications(n, at(85), 7 * HOUR, true).map(x => x.reset), [false], '80 crossed');
eq(notifications(n, at(86), 7 * HOUR, true).length, 0, '80 not repeated');
eq(notifications(n, at(97), 8 * HOUR, true).map(x => x.reset), [false], '95 crossed');
eq(notifications(n, at(97), 10 * HOUR, false).map(x => x.reset), [true], 'reset on tick');
eq(notifications(n, at(97), 10 * HOUR, true).length, 0, 'stale data after reset ignored');
eq(notifications(n, at(5, 15 * HOUR), 11 * HOUR, true).length, 0, 'new window quiet');
eq(notifications({}, at(99), 8 * HOUR, true).length, 1, 'jump straight to 95 notifies once');

print('ok');
