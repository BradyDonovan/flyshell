# flyshell

GNOME Shell extension that displays a selected in-flight identifier and progress percentage in the top bar.

![screenshot of top bar flight tracker showing a 70% completed flight progress bar](imgs/topbar.png)

![a configuration menu showing what can be configured for flyshell](imgs/menu.png)

## Behavior

- Uses FlightAware AeroAPI endpoint: `GET /flights/{ident}`.
- Uses defensive filtering to pick the active flight:
	- status contains `En Route` (case-insensitive)
	- `progress_percent > 0` and `< 100`
- Shows indicator text like `UAL1234 28%`.
- Provides a click menu to configure:
	- flight identifier
	- polling rate (seconds)
	- API key (stored in user keyring)

## Security and stability notes

- API key is stored in keyring with `secret-tool`, not in plain text settings.
- Network calls are performed by a Python helper subprocess.
- Extension calls subprocess asynchronously and never blocks the Shell main loop.

## Dependencies

- `python3`
- `secret-tool` (usually from `libsecret` package)

## Local install (development)

Preferred:

```bash
./scripts/install-local.sh
```

Manual fallback:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/flyshell@flyshell
rsync -a --exclude='.git/' --exclude='.gitignore' --exclude='README.md' --exclude='__pycache__/' ./ ~/.local/share/gnome-shell/extensions/flyshell@flyshell/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/flyshell@flyshell/schemas
gnome-extensions enable flyshell@flyshell
```

Restart GNOME Shell (or log out/in on Wayland) after updates.

## No-logout development loop

For most JS/CSS/schema edits you do not need to log out.

Use:

```bash
./scripts/install-local.sh
```

The installer now does an in-place reload by running disable + enable, then
prints extension state.

If you need to reload manually:

```bash
gnome-extensions disable flyshell@flyshell && gnome-extensions enable flyshell@flyshell
```

If state is still ERROR:

```bash
journalctl --user -b --no-pager | grep -i 'flyshell@flyshell' | tail -n 80
```

Note: On Xorg, you can restart GNOME Shell with Alt+F2 then `r`. On Wayland,
full shell restart usually means log out/in.

## First-time setup

1. Click the indicator.
2. Enter and save your AeroAPI key.
3. Enter and save a flight identifier (example: `UAL1234`).
4. Set desired polling rate.
