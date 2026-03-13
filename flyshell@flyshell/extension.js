import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PollManager} from './pollManager.js';
import {FlightRenderer} from './renderer.js';
import {runPython} from './subprocess.js';

const DEFAULT_POLL_SECONDS = 60;
const MIN_POLL_SECONDS = 15;
const MAX_POLL_SECONDS = 3600;
// Intentionally bypasses MIN_POLL_SECONDS to allow rapid polling during development.
const DEBUG_POLL_SECONDS = 1;

class FlightTrackerIndicator {
    constructor(extension) {
        this.actor = new PanelMenu.Button(0.0, 'Flight Tracker Indicator');

        this._extension = extension;
        this._settings = extension.getSettings('org.gnome.shell.extensions.flyshell');
        this._mockSnapshots = null;
        this._mockIndex = 0;
        this._faFlightId = null;
        this._flightFinished = false;

        this.actor.add_style_class_name('flyshell-indicator');

        this._renderer = new FlightRenderer();
        this.actor.add_child(this._renderer.label);
        this._renderer.applyDisplayMode(this._getDisplayMode());

        this._pollManager = new PollManager(
            () => this._doPoll(),
            () => this._isDebugMode() ? DEBUG_POLL_SECONDS : this._getPollSeconds()
        );

        this._statusItem = new PopupMenu.PopupMenuItem('Waiting for configuration...', {
            reactive: false,
            can_focus: false,
        });
        this.actor.menu.addMenuItem(this._statusItem);
        this.actor.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._flightEntry = this._createEntryRow('Flight ID', this._getFlightIdent(), 'Save', () => {
            const ident = this._sanitizeIdent(this._flightEntry.get_text());
            this._settings.set_string('flight-ident', ident);
            this._flightEntry.set_text(ident);
            this._setStatus(`Saved flight ID: ${ident || '(empty)'}`);
            this._pollManager.pollNow();
        });
        this.actor.menu.addMenuItem(this._flightEntry.row);

        this._pollEntry = this._createEntryRow(
            'Poll seconds',
            `${this._getPollSeconds()}`,
            'Save',
            () => {
                const parsed = Number.parseInt(this._pollEntry.get_text(), 10);
                const pollSeconds = Number.isFinite(parsed)
                    ? Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, parsed))
                    : DEFAULT_POLL_SECONDS;

                this._settings.set_int('poll-seconds', pollSeconds);
                this._pollEntry.set_text(`${pollSeconds}`);
                this._setStatus(`Polling every ${pollSeconds}s`);
                this._pollManager.schedule(1);
            }
        );
        this.actor.menu.addMenuItem(this._pollEntry.row);

        this._apiKeyEntry = this._createEntryRow('API key', '', 'Save key', async () => {
            const key = this._apiKeyEntry.get_text().trim();
            if (!key) {
                this._setStatus('API key is empty');
                return;
            }

            try {
                await this._runPython(['set-key'], `${key}\n`);
                this._apiKeyEntry.set_text('');
                this._setStatus('API key saved to keyring');
                this._pollManager.pollNow();
            } catch (error) {
                console.error(`[${this._extension.uuid}] set-key failed: ${error?.stack || error}`);
                this._setStatus(`Failed to save API key: ${error.message}`);
            }
        });
        if (this._apiKeyEntry.clutter_text)
            this._apiKeyEntry.clutter_text.set_password_char('\u2022');
        this.actor.menu.addMenuItem(this._apiKeyEntry.row);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._pollManager.pollNow());
        this.actor.menu.addMenuItem(refreshItem);

        this.actor.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._displayModeToggle = new PopupMenu.PopupSwitchMenuItem(
            'Show Progress Bar',
            this._getDisplayMode() === 'progress-bar'
        );
        this._displayModeToggle.connect('toggled', (_item, state) => {
            this._settings.set_string('display-mode', state ? 'progress-bar' : 'percentage');
        });
        this.actor.menu.addMenuItem(this._displayModeToggle);

        this._debugToggle = new PopupMenu.PopupSwitchMenuItem(
            'Debug Mode',
            this._settings.get_boolean('debug-mode')
        );
        this._debugToggle.connect('toggled', (_item, state) => {
            this._settings.set_boolean('debug-mode', state);
        });
        this.actor.menu.addMenuItem(this._debugToggle);

        this._offlineToggle = new PopupMenu.PopupSwitchMenuItem(
            'Offline Mode',
            this._settings.get_boolean('offline-mode')
        );
        this._offlineToggle.connect('toggled', (_item, state) => {
            this._settings.set_boolean('offline-mode', state);
        });
        this.actor.menu.addMenuItem(this._offlineToggle);

        this._replayItem = new PopupMenu.PopupMenuItem('Replay Mock Flight');
        this._replayItem.connect('activate', () => {
            if (this._isDebugMode()) {
                this._mockIndex = 0;
                this._setStatus('Debug mode: replaying mock flight');
                this._pollManager.schedule(1);
            }
        });
        this._replayItem.visible = this._settings.get_boolean('debug-mode');
        this.actor.menu.addMenuItem(this._replayItem);

        this._settingsChangedId = this._settings.connect('changed::flight-ident', () => {
            this._flightEntry.set_text(this._getFlightIdent());
            this._faFlightId = null;
            this._flightFinished = false;
            this._pollManager.pollNow();
        });
        this._pollChangedId = this._settings.connect('changed::poll-seconds', () => {
            this._pollEntry.set_text(`${this._getPollSeconds()}`);
            this._pollManager.schedule(1);
        });
        this._debugChangedId = this._settings.connect('changed::debug-mode', () => {
            if (this._debugToggle)
                this._debugToggle.setToggleState(this._settings.get_boolean('debug-mode'));
            this._onDebugModeChanged();
        });
        this._displayModeChangedId = this._settings.connect('changed::display-mode', () => {
            if (this._displayModeToggle)
                this._displayModeToggle.setToggleState(this._getDisplayMode() === 'progress-bar');
            this._renderer.applyDisplayMode(this._getDisplayMode());
        });
        this._offlineChangedId = this._settings.connect('changed::offline-mode', () => {
            if (this._offlineToggle)
                this._offlineToggle.setToggleState(this._settings.get_boolean('offline-mode'));
            this._onOfflineModeChanged();
        });

        this._setStatus('Configure API key on first use');
        this._pollManager.schedule(1);
    }

    destroy() {
        this._pollManager.destroy();

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._pollChangedId) {
            this._settings.disconnect(this._pollChangedId);
            this._pollChangedId = 0;
        }

        if (this._debugChangedId) {
            this._settings.disconnect(this._debugChangedId);
            this._debugChangedId = 0;
        }

        if (this._displayModeChangedId) {
            this._settings.disconnect(this._displayModeChangedId);
            this._displayModeChangedId = 0;
        }

        if (this._offlineChangedId) {
            this._settings.disconnect(this._offlineChangedId);
            this._offlineChangedId = 0;
        }

        this._settings = null;
        this.actor?.destroy();
        this.actor = null;
    }

    _createEntryRow(labelText, value, buttonText, onSave) {
        const row = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        row.label.visible = false;

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'flyshell-menu-row',
        });

        const label = new St.Label({
            text: labelText,
            style_class: 'flyshell-row-label',
        });
        box.add_child(label);

        const controls = new St.BoxLayout({
            x_expand: true,
            style_class: 'flyshell-row-controls',
        });

        const entry = new St.Entry({
            text: value,
            can_focus: true,
            x_expand: true,
            hint_text: labelText,
            style_class: 'flyshell-entry',
        });
        controls.add_child(entry);

        const button = new St.Button({
            label: buttonText,
            can_focus: true,
            style_class: 'flyshell-button',
        });
        button.connect('clicked', () => {
            Promise.resolve(onSave()).catch(error => {
                this._setStatus(`Action failed: ${error.message}`);
            });
        });
        controls.add_child(button);

        entry.clutter_text.connect('activate', () => {
            Promise.resolve(onSave()).catch(error => {
                this._setStatus(`Action failed: ${error.message}`);
            });
        });

        box.add_child(controls);
        row.add_child(box);

        entry.row = row;
        return entry;
    }

    _isDebugMode() {
        return this._settings.get_boolean('debug-mode');
    }

    _loadMockData() {
        try {
            const mockPath = GLib.build_filenamev([this._extension.path, 'mock_flight.json']);
            const [ok, contents] = GLib.file_get_contents(mockPath);
            if (!ok)
                throw new Error('Could not read mock_flight.json');

            const text = new TextDecoder().decode(contents);
            const data = JSON.parse(text);
            this._mockSnapshots = data.snapshots || [];
            this._mockIndex = 0;
            this._setStatus('Debug mode: mock flight loaded');
        } catch (error) {
            console.error(`[${this._extension.uuid}] Failed to load mock data: ${error?.stack || error}`);
            this._mockSnapshots = null;
            this._setStatus(`Debug mode error: ${error.message}`);
        }
    }

    _onDebugModeChanged() {
        if (this._isDebugMode()) {
            this._loadMockData();
        } else {
            this._mockSnapshots = null;
            this._mockIndex = 0;
            this._setStatus('Debug mode disabled');
        }
        if (this._replayItem)
            this._replayItem.visible = this._isDebugMode();
        this._pollManager.schedule(1);
    }

    /* ── Offline mode ── */

    _isOfflineMode() {
        return this._settings.get_boolean('offline-mode');
    }

    _onOfflineModeChanged() {
        if (this._isOfflineMode()) {
            this._setStatus('Offline mode: fetching flight data once...');
            this._offlineDataFetched = false;
        } else {
            this._settings.set_string('offline-ident', '');
            this._settings.set_string('offline-departure', '');
            this._settings.set_string('offline-arrival', '');
            this._offlineDataFetched = false;
            this._setStatus('Offline mode disabled');
        }
        this._pollManager.schedule(1);
    }

    _computeOfflineProgress() {
        const offStr = this._settings.get_string('offline-departure');
        const inStr = this._settings.get_string('offline-arrival');
        const ident = this._settings.get_string('offline-ident');

        if (!offStr || !inStr || !ident) {
            return null;
        }

        const offMs = Date.parse(offStr);
        const inMs = Date.parse(inStr);
        const nowMs = Date.now();

        if (Number.isNaN(offMs) || Number.isNaN(inMs) || inMs <= offMs) {
            return null;
        }

        const totalDuration = inMs - offMs;
        const elapsed = nowMs - offMs;
        const pct = Math.max(0, Math.min(100, Math.round((elapsed / totalDuration) * 100)));

        return {ident, progress: pct, offStr, inStr};
    }

    _pollOffline() {
        const result = this._computeOfflineProgress();
        if (!result) {
            this._setStatus('Offline: missing cached timestamps');
            return;
        }

        this._renderer.setFlightDisplay(result.ident, result.progress, this._getDisplayMode());

        if (result.progress >= 100) {
            this._setStatus(`Offline: arrived (est. ${result.inStr})`);
        } else if (result.progress <= 0) {
            this._setStatus(`Offline: not departed yet (dep. ${result.offStr})`);
        } else {
            this._setStatus(`Offline: ${result.progress}% — dep ${result.offStr} → arr ${result.inStr}`);
        }
    }

    _pollMock() {
        if (!this._mockSnapshots)
            this._loadMockData();

        if (!this._mockSnapshots || this._mockSnapshots.length === 0) {
            this._renderer.setText('Mock: no data');
            this._setStatus('No mock snapshots available');
            return;
        }

        const snapshot = this._mockSnapshots[this._mockIndex];
        const ident = snapshot.ident || 'MOCK001';
        const progress = snapshot.progress_percent ?? 0;

        this._renderer.setFlightDisplay(ident, progress, this._getDisplayMode());
        this._setStatus(`${snapshot.status || 'En route'} [mock ${this._mockIndex + 1}/${this._mockSnapshots.length}]`);

        if (this._mockIndex < this._mockSnapshots.length - 1)
            this._mockIndex++;
    }

    /* ── Display-mode helpers ── */

    _getDisplayMode() {
        return this._settings.get_string('display-mode') || 'percentage';
    }

    _sanitizeIdent(ident) {
        return ident.trim().toUpperCase().replace(/\s+/g, '');
    }

    _getFlightIdent() {
        return this._sanitizeIdent(this._settings.get_string('flight-ident') || '');
    }

    _getPollSeconds() {
        const value = this._settings.get_int('poll-seconds');
        return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, value || DEFAULT_POLL_SECONDS));
    }

    _setStatus(text) {
        if (this._statusItem?.label)
            this._statusItem.label.text = text;
    }

    /* ── Poll orchestration ── */

    async _doPoll() {
        try {
            if (this._isDebugMode()) {
                this._pollMock();
                return;
            }

            /* ── Offline mode: fetch once, then compute locally ── */
            if (this._isOfflineMode()) {
                if (this._offlineDataFetched) {
                    this._pollOffline();
                    return;
                }

                // First poll in offline mode — do a single API fetch
                const ident = this._getFlightIdent();
                if (!ident) {
                    this._renderer.setText('Flight: set ID');
                    this._setStatus('Set a flight ID, for example UAL1234');
                    return;
                }

                this._setStatus('Offline: fetching flight data...');
                const result = await this._runPython(['fetch-offline', '--ident', ident]);
                if (!result.selected) {
                    this._renderer.setText(`${ident} --`);
                    this._setStatus(result.message || 'No flight found for offline mode');
                    return;
                }

                const sel = result.selected;
                this._settings.set_string('offline-ident', sel.ident || ident);
                this._settings.set_string('offline-departure', sel.departure || '');
                this._settings.set_string('offline-arrival', sel.arrival || '');
                this._offlineDataFetched = true;

                this._setStatus(`Offline: cached ${sel.ident} — dep ${sel.departure} → arr ${sel.arrival}`);
                this._pollOffline();
                return;
            }

            const ident = this._getFlightIdent();

            const keyState = await this._runPython(['has-key']);
            if (!keyState.has_key) {
                this._renderer.setText('Flight: set API key');
                this._setStatus('First use: save your AeroAPI key in the menu');
                return;
            }

            if (!ident) {
                this._renderer.setText('Flight: set ID');
                this._setStatus('Set a flight ID, for example UAL1234');
                return;
            }

            if (this._flightFinished)
                return;

            const queryId = this._faFlightId || ident;
            const result = await this._runPython(['query', '--ident', queryId]);
            if (!result.selected) {
                this._renderer.setText(`${ident} --`);
                this._setStatus(result.message || 'No in-flight match found');
                this._faFlightId = null;
                return;
            }

            if (result.selected.fa_flight_id)
                this._faFlightId = result.selected.fa_flight_id;

            const selectedIdent = result.selected.ident || ident;
            const progress = Number.parseInt(result.selected.progress_percent, 10);
            const safeProgress = Number.isFinite(progress) ? progress : 0;

            if (safeProgress >= 100) {
                this._flightFinished = true;
                this._faFlightId = null;
                this._renderer.setText(`${selectedIdent} ✅`);
                this._setStatus(result.selected.status || 'Arrived');
                return;
            }

            this._renderer.setFlightDisplay(selectedIdent, safeProgress, this._getDisplayMode());
            this._setStatus(result.selected.status || 'En route');
        } catch (error) {
            this._renderer.setText('Flight: error');
            this._setStatus(error.message);
        }
    }

    async _runPython(args, stdinText = '') {
        return runPython(this._extension.path, this._extension.uuid, args, stdinText);
    }
}

export default class FlyshellExtension extends Extension {
    enable() {
        try {
            this._panel = Main.panel;
            this._panel?.add_style_class_name('flyshell-enabled');

            this._indicator = new FlightTrackerIndicator(this);
            Main.panel.addToStatusArea(this.uuid, this._indicator.actor, 0, 'right');
            console.log(`[${this.uuid}] enabled`);
        } catch (error) {
            console.error(`[${this.uuid}] enable failed: ${error?.stack || error}`);
            throw error;
        }
    }

    disable() {
        this._panel?.remove_style_class_name('flyshell-enabled');
        this._panel = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
