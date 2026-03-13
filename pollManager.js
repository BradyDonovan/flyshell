import GLib from 'gi://GLib';

export class PollManager {
    /**
     * @param {Function} pollFn  — async function to execute each poll tick
     * @param {Function} getDelay — returns default delay in seconds
     */
    constructor(pollFn, getDelay) {
        this._pollFn = pollFn;
        this._getDelay = getDelay;
        this._sourceId = null;
        this._inFlight = false;
    }

    schedule(overrideSeconds = null) {
        this._clearSource();
        const seconds = overrideSeconds ?? this._getDelay();

        this._sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this.pollNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    async pollNow() {
        if (this._inFlight)
            return;

        this._inFlight = true;
        try {
            await this._pollFn();
        } finally {
            this._inFlight = false;
            this.schedule();
        }
    }

    destroy() {
        this._clearSource();
    }

    _clearSource() {
        if (!this._sourceId)
            return;

        GLib.source_remove(this._sourceId);
        this._sourceId = null;
    }
}
