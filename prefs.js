import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DISPLAY_MODES = ['percentage', 'progress-bar'];
const DISPLAY_LABELS = ['Percentage (e.g. UAL1234 42%)', 'Airplane progress bar ✈'];

export default class FlyshellPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(540, 420);
        window.set_title('flyshell Preferences');

        const settings = this.getSettings('org.gnome.shell.extensions.flyshell');

        const page = new Adw.PreferencesPage({title: 'General'});
        window.add(page);

        /* ── Display ── */
        const displayGroup = new Adw.PreferencesGroup({title: 'Display'});
        page.add(displayGroup);

        const model = new Gtk.StringList();
        for (const label of DISPLAY_LABELS)
            model.append(label);

        const displayRow = new Adw.ComboRow({
            title: 'Display Mode',
            subtitle: 'How flight progress is shown in the top bar',
            model,
        });

        const currentMode = settings.get_string('display-mode');
        const currentIdx = DISPLAY_MODES.indexOf(currentMode);
        displayRow.set_selected(currentIdx >= 0 ? currentIdx : 0);

        displayRow.connect('notify::selected', () => {
            const idx = displayRow.get_selected();
            if (idx >= 0 && idx < DISPLAY_MODES.length)
                settings.set_string('display-mode', DISPLAY_MODES[idx]);
        });

        displayGroup.add(displayRow);

        /* ── Offline mode ── */
        const offlineGroup = new Adw.PreferencesGroup({title: 'Offline Mode'});
        page.add(offlineGroup);

        const offlineRow = new Adw.SwitchRow({
            title: 'Offline Mode',
            subtitle: 'Fetch flight once, then compute progress from current time vs departure/arrival',
        });
        offlineGroup.add(offlineRow);

        settings.bind('offline-mode', offlineRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        /* ── Developer ── */
        const group = new Adw.PreferencesGroup({title: 'Developer'});
        page.add(group);

        const debugRow = new Adw.SwitchRow({
            title: 'Debug Mode',
            subtitle: 'Use bundled mock flight data with 1 s polling instead of the live API',
        });
        group.add(debugRow);

        settings.bind('debug-mode', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    }
}
