import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export async function runPython(extensionPath, extensionUuid, args, stdinText = '') {
    const python = GLib.find_program_in_path('python3');
    if (!python)
        throw new Error('python3 was not found on PATH');

    const scriptPath = GLib.build_filenamev([extensionPath, 'scripts', 'fetch_flight.py']);
    const argv = [python, scriptPath, ...args];

    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

    let stdout;
    let stderr;
    try {
        const response = await new Promise((resolve, reject) => {
            proc.communicate_utf8_async(stdinText, null, (self, result) => {
                try {
                    resolve(self.communicate_utf8_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });

        // GJS version-dependent: communicate_utf8_finish returns
        // [ok, stdout, stderr] (3 elements) or [stdout, stderr] (2).
        if (Array.isArray(response)) {
            if (response.length >= 3)
                [, stdout, stderr] = response;
            else
                [stdout, stderr] = response;
        }

        stdout = stdout ?? '';
        stderr = stderr ?? '';
    } catch (error) {
        console.error(`[${extensionUuid}] subprocess communicate failed; argv=${JSON.stringify(argv)}: ${error?.stack || error}`);
        throw new Error(`Subprocess communication failed: ${error.message}`);
    }

    const exitStatus = proc.get_exit_status();
    if (exitStatus !== 0) {
        const message = (stderr || stdout || '').trim() || `helper exited ${exitStatus}`;
        throw new Error(message);
    }

    try {
        return JSON.parse(stdout || '{}');
    } catch (error) {
        throw new Error(`Invalid helper JSON: ${error.message}`);
    }
}
