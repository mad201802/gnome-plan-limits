# Plan Limits Meter (GNOME Shell 45-50)

Unofficial top-bar indicator that shows your Claude Code plan limits: the 5h session and weekly windows, with reset times, pace, and notifications at 80% / 95%.

Reads `~/.claude/.credentials.json` read-only and calls `GET https://api.anthropic.com/api/oauth/usage` every 5 min.
It never refreshes or writes the OAuth token, because doing that is what logs you out of other tools. When the token has expired,
it runs `claude -p /usage --safe-mode --no-session-persistence` once, so the official CLI refreshes the token. That command makes no model call.

Requires a logged-in [Claude Code](https://code.claude.com) CLI.

## Install

    git clone https://github.com/mad201802/gnome-plan-limits \
        ~/.local/share/gnome-shell/extensions/plan-limits@mad201802.github.io
    # log out and back in (Wayland), then:
    gnome-extensions enable plan-limits@mad201802.github.io

## Dev

    gjs -m test.js
    dbus-run-session -- gnome-shell --devkit --wayland   # GNOME 49+, needs mutter-devkit; older: --nested
    journalctl --user -f -o cat /usr/bin/gnome-shell

## Disclaimer

This is an unofficial community project. It is not affiliated with, endorsed by, or sponsored by Anthropic.
"Claude" and "Claude Code" are trademarks of Anthropic, PBC.

The extension uses an undocumented Anthropic endpoint with the OAuth token of your local Claude Code login.
That endpoint may change or stop working at any time, and this kind of access may conflict with Anthropic's terms of service.
Use it at your own risk.

## License

GPL-2.0-or-later. Copyright (C) 2026 mad201802. See [LICENSE](LICENSE).
