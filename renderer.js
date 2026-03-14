import St from 'gi://St';
import Clutter from 'gi://Clutter';

const BAR_LENGTH = 10;

export class FlightRenderer {
    constructor() {
        this._lastProgress = 0;
        this._lastIdent = '';
        this._staticText = null;
        this._label = new St.Label({
            text: 'Flight: setup',
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    get label() {
        return this._label;
    }

    get lastProgress() {
        return this._lastProgress;
    }

    get lastIdent() {
        return this._lastIdent;
    }

    setText(text) {
        this._label.text = text;
        this._staticText = text;
    }

    setFlightDisplay(ident, progress, displayMode) {
        this._lastProgress = progress;
        this._lastIdent = ident || '';
        this._staticText = null;
        if (displayMode === 'progress-bar')
            this._updateProgressBar(progress, ident);
        else
            this._label.text = `${ident} ${progress}%`;
    }

    applyDisplayMode(displayMode) {
        if (displayMode === 'progress-bar')
            this._label.add_style_class_name('flyshell-progress-label');
        else
            this._label.remove_style_class_name('flyshell-progress-label');

        if (this._staticText !== null)
            return;

        if (displayMode === 'progress-bar')
            this._updateProgressBar(this._lastProgress, this._lastIdent);
        else
            this._label.text = `${this._lastIdent} ${this._lastProgress}%`;
    }

    renderBar(percent, ident = '') {
        const position = Math.round(percent / 100 * (BAR_LENGTH - 1));
        const prefix = ident ? `${ident} ` : '';
        return prefix + '─'.repeat(position) + '✈' + '─'.repeat(BAR_LENGTH - 1 - position) + ` ${percent}%`;
    }

    _updateProgressBar(percent, ident = '') {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        this._label.set_text(this.renderBar(clamped, ident));
    }
}
