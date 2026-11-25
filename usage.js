// SPDX-License-Identifier: GPL-2.0-or-later
// Pure helpers, no shell imports, so test.js runs them under plain gjs.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
const THRESHOLDS = [80, 95];

const WINDOWS = [
    ['session', 'five_hour', 'Session (5h)', 5 * HOUR],
    ['weekly', 'seven_day', 'Weekly (all models)', 7 * 24 * HOUR],
];

// Response of GET /api/oauth/usage -> one entry per window.
export function parseUsage(json) {
    return WINDOWS.map(([key, field, title, windowMs]) => {
        const w = json?.[field];
        const resetsAt = Date.parse(w?.resets_at ?? '');
        return {
            key, title, windowMs,
            pct: typeof w?.utilization === 'number' ? Math.floor(w.utilization) : null,
            resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
        };
    });
}

export function pace({pct, resetsAt, windowMs}, now) {
    if (pct === null || resetsAt === null)
        return null;
    const start = resetsAt - windowMs;
    const elapsed = Math.min(Math.max(now - start, 0), windowMs);
    const elapsedPct = Math.round(elapsed / windowMs * 100);
    // ponytail: linear extrapolation from window start, noisy in the first minutes; skipped below 5% elapsed
    let hitAt = null;
    if (pct > 0 && elapsed >= windowMs * 0.05 && start + elapsed * 100 / pct < resetsAt)
        hitAt = start + elapsed * 100 / pct;
    return {elapsedPct, ahead: pct > elapsedPct, hitAt};
}

// 'in 2h 41m' style, compact = '2h41m'
export function fmtDuration(ms, compact = false) {
    const m = Math.max(0, Math.ceil(ms / MIN));
    const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60);
    const parts = d ? [`${d}d`, `${h}h`] : h ? [`${h}h`, `${m % 60}m`] : [`${m}m`];
    return parts.join(compact ? '' : ' ');
}

export function levelClass(pct) {
    return pct >= 90 ? 'cu-crit' : pct >= 75 ? 'cu-warn' : '';
}

// Mutates `notified` ({key: {level, resetsAt}}), returns [{limit, reset}] to show.
// Thresholds are only checked on fresh data, so stale values after a reset don't re-fire.
export function notifications(notified, data, now, fresh) {
    const out = [];
    for (const l of data) {
        const n = notified[l.key] ??= {level: 0, resetsAt: 0};
        if (n.level && now >= n.resetsAt) {
            if (n.level >= 95)
                out.push({limit: l, reset: true});
            n.level = 0;
        }
        if (!fresh || l.pct === null || !(l.resetsAt > now))
            continue;
        const t = THRESHOLDS.filter(x => l.pct >= x && x > n.level).pop();
        if (t) {
            n.level = t;
            n.resetsAt = l.resetsAt;
            out.push({limit: l, reset: false});
        }
    }
    return out;
}
