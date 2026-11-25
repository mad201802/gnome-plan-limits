// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {parseUsage, pace, fmtDuration, levelClass, notifications, MIN, HOUR} from './usage.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

const API_URL = 'https://api.anthropic.com/api/oauth/usage';
const WEB_URL = 'https://claude.ai/settings/usage';
const CREDS = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const POLL_S = 300;
const CLI_THROTTLE = 15 * MIN;

const decode = bytes => new TextDecoder().decode(bytes);

export default class PlanLimitsExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        // Plain data only. The shell disables extensions while the screen is locked; keeping this
        // on the instance preserves last values, 429 backoff, CLI state and notification levels across unlocks.
        this._state = {data: null, updatedAt: 0, error: null, retryAt: 0, backoff: 0, cliAt: 0, cliRunning: false, notified: {}};
    }

    enable() {
        this._session = new Soup.Session({user_agent: `gnome-plan-limits/${this.metadata['version-name']}`, timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this._indicator = new PanelMenu.Button(0.5, this.metadata.name);
        const box = new St.BoxLayout();
        box.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${this.path}/icons/plan-limits-symbolic.svg`),
            style_class: 'system-status-icon',
        }));
        const label = text => {
            const l = new St.Label({text, y_align: Clutter.ActorAlign.CENTER});
            // Ellipsizing labels have 1px min width; a crowded panel would shrink them to nothing.
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            return l;
        };
        this._warnLabel = label('⚠ ');
        this._sessionLabel = label('…');
        this._weeklyLabel = label('');
        for (const l of [this._warnLabel, this._sessionLabel, label(' · '), this._weeklyLabel])
            box.add_child(l);
        this._indicator.add_child(box);
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refreshIfStale();
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_S, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._onTick();
            return GLib.SOURCE_CONTINUE;
        });

        this._render();
        this._refreshIfStale();
    }

    disable() {
        // A running claude CLI is deliberately left alone: killing it mid token refresh
        // would lose the rotated refresh token and log the user out.
        this._cancellable.cancel();
        this._session.abort();
        GLib.source_remove(this._pollId);
        GLib.source_remove(this._tickId);
        this._indicator.destroy();
        this._indicator = this._session = this._cancellable = this._ifaceSettings = null;
        this._warnLabel = this._sessionLabel = this._weeklyLabel = null;
        this._busy = false;
    }

    _refreshIfStale() {
        if (Date.now() - this._state.updatedAt > MIN)
            this._refresh();
    }

    async _readCreds() {
        try {
            const [bytes] = await Gio.File.new_for_path(CREDS).load_contents_async(this._cancellable);
            return JSON.parse(decode(bytes)).claudeAiOauth ?? null;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return null;
            throw e;
        }
    }

    // Never refreshes or writes the OAuth token itself; an expired token is handed to the CLI.
    async _refresh(manual = false) {
        if (this._busy || !this._indicator || (!manual && Date.now() < this._state.retryAt))
            return;
        this._busy = true;
        try {
            const creds = await this._readCreds();
            if (!creds?.accessToken) {
                this._state.error = 'Not logged in: run claude';
                return;
            }
            if (creds.expiresAt - Date.now() < MIN) {
                this._cliRefresh(manual);
                return;
            }
            const msg = Soup.Message.new('GET', API_URL);
            msg.request_headers.append('Authorization', `Bearer ${creds.accessToken}`);
            msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
            const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
            const status = msg.get_status();
            if (status === 200) {
                this._state.data = parseUsage(JSON.parse(decode(bytes.get_data())));
                this._state.updatedAt = Date.now();
                this._state.error = null;
                this._state.backoff = this._state.retryAt = 0;
                this._notify(true);
            } else if (status === 401) {
                this._cliRefresh(manual);
            } else if (status === 429) {
                const retryAfter = Number(msg.response_headers.get_one('retry-after'));
                this._state.backoff = Math.min(this._state.backoff ? this._state.backoff * 2 : 5, 60);
                this._state.retryAt = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : this._state.backoff * MIN);
                this._state.error = `Rate limited, retry at ${this._time(this._state.retryAt)}`;
            } else {
                this._state.error = `Server error (HTTP ${status})`;
            }
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._state.error = `Fetch failed: ${e.message}`;
        } finally {
            this._busy = false;
            this._render();
        }
    }

    // Lets the official CLI refresh the token (it locks + rewrites the credentials file itself).
    // `/usage` is a local command: no model call, no quota used, no transcript with --no-session-persistence.
    _cliRefresh(manual) {
        if (this._state.cliRunning || (!manual && Date.now() - this._state.cliAt < CLI_THROTTLE)) {
            this._state.error ??= 'Token expired: open Claude Code';
            return;
        }
        const claude = GLib.find_program_in_path('claude') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude']);
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        launcher.set_stdin_file_path('/dev/null');
        launcher.set_cwd(GLib.get_home_dir());
        let proc;
        try {
            proc = launcher.spawnv([claude, '-p', '/usage', '--safe-mode', '--no-session-persistence']);
        } catch (e) {
            this._state.error = `Cannot run claude: ${e.message}`;
            return;
        }
        this._state.cliRunning = true;
        this._state.cliAt = Date.now();
        this._state.error = 'Token expired, refreshing via claude CLI…';
        // No cancellable: completion must clear cliRunning even if disabled meanwhile.
        proc.wait_async(null).catch(() => {}).then(() => this._afterCli());
    }

    async _afterCli() {
        this._state.cliRunning = false;
        if (!this._indicator)
            return;
        try {
            const creds = await this._readCreds();
            if (!creds?.accessToken || creds.expiresAt - Date.now() < MIN) {
                this._state.error = 'Logged out: run claude, then /login';
                this._render();
                return;
            }
        } catch (e) {
            if (!this._indicator)
                return;
        }
        this._state.error = null;
        this._refresh(true);
    }

    _onTick() {
        const now = Date.now();
        // Refetch once right after a window resets instead of waiting for the next poll.
        if (this._state.data?.some(l => l.resetsAt !== null && now >= l.resetsAt && this._state.updatedAt < l.resetsAt))
            this._refresh();
        this._notify(false);
        this._render();
    }

    _notify(fresh) {
        const now = Date.now();
        for (const {limit: l, reset} of notifications(this._state.notified, this._state.data ?? [], now, fresh)) {
            if (reset)
                Main.notify(`Claude ${l.key} limit reset`, 'Full quota available again.');
            else
                Main.notify(`Claude ${l.key} limit at ${l.pct}%`, `Resets ${this._when(l.resetsAt)} (in ${fmtDuration(l.resetsAt - now)})`);
        }
    }

    _fmt(ms, format) {
        return GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format(format);
    }

    _time(ms) {
        return this._ifaceSettings.get_string('clock-format') === '24h'
            ? this._fmt(ms, '%H:%M') : this._fmt(ms, '%l:%M %p').trim();
    }

    _when(ms) {
        return ms - Date.now() < 20 * HOUR ? this._time(ms) : `${this._fmt(ms, '%a %-d %b')} ${this._time(ms)}`;
    }

    _render() {
        if (!this._indicator)
            return;
        const now = Date.now();
        const pctText = l => l?.pct === null || l?.pct === undefined ? '–' : `${l.pct}%`;
        const [s, w] = this._state.data ?? [];
        this._sessionLabel.text = this._state.data
            ? pctText(s) + (s.resetsAt > now ? ` (${fmtDuration(s.resetsAt - now, true)})` : '') : '…';
        this._weeklyLabel.text = this._state.data ? pctText(w) : '…';
        this._sessionLabel.style_class = levelClass(s?.pct);
        this._weeklyLabel.style_class = levelClass(w?.pct);
        this._warnLabel.visible = !!this._state.error;
        for (const l of [this._sessionLabel, this._weeklyLabel])
            l.opacity = this._state.error ? 128 : 255;

        const menu = this._indicator.menu;
        menu.removeAll();
        for (const l of this._state.data ?? [])
            this._addLimit(menu, l, now);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this._state.error)
            this._addRow(menu, `⚠ ${this._state.error}`);
        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        if (this._state.updatedAt) {
            refresh.add_child(new St.Label({
                text: `Updated ${this._time(this._state.updatedAt)}`,
                x_expand: true, x_align: Clutter.ActorAlign.END, opacity: 160,
            }));
        }
        refresh.connect('activate', () => this._refresh(true));
        menu.addMenuItem(refresh);
        menu.addAction('Open claude.ai usage settings', () => Gio.AppInfo.launch_default_for_uri(WEB_URL, null));
    }

    _addRow(menu, text) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'cu-row'});
        if (text)
            item.add_child(new St.Label({text, x_expand: true}));
        menu.addMenuItem(item);
        return item;
    }

    _addLimit(menu, l, now) {
        const title = this._addRow(menu, l.title);
        title.add_style_class_name('cu-title');
        title.remove_style_pseudo_class('insensitive'); // non-reactive rows render dimmed; keep titles bright
        title.add_child(new St.Label({
            text: l.pct === null ? '–' : `${l.pct}%`,
            style_class: levelClass(l.pct),
            x_align: Clutter.ActorAlign.END,
        }));
        const p = pace(l, now);
        const bar = new St.DrawingArea({style_class: 'cu-bar', x_expand: true});
        bar.connect('repaint', area => drawBar(area, l.pct ?? 0, p?.elapsedPct));
        this._addRow(menu).add_child(bar);
        if (l.resetsAt === null)
            return;
        if (l.pct >= 100) {
            this._addRow(menu, `Limit reached, resets ${this._when(l.resetsAt)} (in ${fmtDuration(l.resetsAt - now)})`);
            return;
        }
        this._addRow(menu, `Resets ${this._when(l.resetsAt)} (in ${fmtDuration(l.resetsAt - now)})`);
        if (l.key === 'session')
            this._addRow(menu, `Window ${this._time(l.resetsAt - l.windowMs)} - ${this._time(l.resetsAt)}`);
        if (p) {
            this._addRow(menu, `Pace: ${l.pct}% used, ${p.elapsedPct}% elapsed${p.ahead ? '' : ' (on track)'}`);
            if (p.hitAt)
                this._addRow(menu, `→ limit at ~${this._time(p.hitAt)} (${fmtDuration(l.resetsAt - p.hitAt, true)} before reset)`);
        }
    }
}

// Track, usage fill colored by level, 2px tick at linear-pace position.
function drawBar(area, pct, elapsedPct) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const fg = area.get_theme_node().get_foreground_color();
    const [r, g, b] = [fg.red / 255, fg.green / 255, fg.blue / 255];
    cr.setSourceRGBA(r, g, b, 0.2);
    cr.rectangle(0, 0, w, h);
    cr.fill();
    cr.setSourceRGBA(...pct >= 90 ? [0.88, 0.11, 0.14] : pct >= 75 ? [0.96, 0.83, 0.18] : [0.21, 0.52, 0.89], 1);
    cr.rectangle(0, 0, w * Math.min(pct, 100) / 100, h);
    cr.fill();
    if (elapsedPct !== undefined) {
        cr.setSourceRGBA(r, g, b, 1);
        cr.rectangle(Math.min(Math.round(w * elapsedPct / 100), w - 2), 0, 2, h);
        cr.fill();
    }
    cr.$dispose();
}
