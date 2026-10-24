const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const net = require('net');

const PORT = 5730;
const PANEL_URL = 'http://localhost:' + PORT + '/';

// Only one copy can run - they'd both want port 5730. A second launch just brings this one forward.
if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

// Keep the preview animating when the window is behind other windows or minimised
// (Chromium throttles hidden windows by default), same as Gift Looper.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let win = null;

// ---- Data folder ----
// Wheels, photos and fonts live in AppData so installing an update never touches them.
function dataDir() {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// First run: bring over everything from the Desktop "Coullseys Lucky Wheel" folder the wheel used to run from.
function importOldFolder(dir) {
    if (fs.existsSync(path.join(dir, 'wheels.json'))) return;
    const old = path.join(app.getPath('desktop'), 'Coullseys Lucky Wheel');
    if (!fs.existsSync(path.join(old, 'wheels.json'))) return;
    try {
        fs.copyFileSync(path.join(old, 'wheels.json'), path.join(dir, 'wheels.json'));
        for (const sub of ['images', 'fonts']) {
            if (fs.existsSync(path.join(old, sub))) fs.cpSync(path.join(old, sub), path.join(dir, sub), { recursive: true });
        }
        console.log('Imported wheels, photos and fonts from ' + old);
    } catch (e) {
        console.log('Could not import from ' + old + ': ' + e.message);
    }
}

// The wheel's log (spins, webhooks, keybinds) goes to wheel.log in the data folder.
function logToFile(dir) {
    const file = path.join(dir, 'wheel.log');
    try {
        if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.old');
    } catch (e) { /* ignore */ }
    const original = console.log;
    console.log = (...args) => {
        original(...args);
        const line = new Date().toLocaleString() + '  ' + args.join(' ') + '\n';
        fs.appendFile(file, line, () => {});
    };
}

function portFree(port) {
    return new Promise(resolve => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        probe.listen(port);
    });
}

// ---- Auto updates (GitHub Releases, see "publish" in package.json) ----
let updateStatus = { state: 'idle' };
function setupAutoUpdates() {
    const send = st => {
        updateStatus = st;
        if (win && !win.isDestroyed()) win.webContents.send('update:status', st);
    };
    ipcMain.handle('update:getStatus', () => updateStatus);
    ipcMain.on('update:install', () => {
        if (updateStatus.state === 'ready') autoUpdater.quitAndInstall(true, true); // silent install, then relaunch
    });
    // Manual "Check for updates" button. Returns { result: 'dev' | 'ready' | 'available' | 'latest' | 'error', version, error }.
    ipcMain.handle('update:check', async () => {
        if (!app.isPackaged) return { result: 'dev' };
        if (updateStatus.state === 'ready') return { result: 'ready', version: updateStatus.version };
        try {
            const r = await autoUpdater.checkForUpdates();
            if (r && r.isUpdateAvailable) return { result: 'available', version: r.updateInfo.version }; // download starts automatically
            return { result: 'latest', version: app.getVersion() };
        } catch (e) {
            // nothing released on GitHub yet means this is the newest there is
            if (/No published versions/i.test(e && e.message)) return { result: 'latest', version: app.getVersion() };
            return { result: 'error', error: e && e.message };
        }
    });
    if (!app.isPackaged) return; // nothing to update when running with `npm start`

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // if the button is ignored, it installs on next close
    autoUpdater.on('download-progress', p => send({ state: 'downloading', percent: p.percent }));
    autoUpdater.on('update-downloaded', info => send({ state: 'ready', version: info.version }));
    autoUpdater.on('error', err => {
        console.log('Auto-update error: ' + (err && err.message));
        if (updateStatus.state !== 'ready') send({ state: 'idle' });
    });
    const check = () => autoUpdater.checkForUpdates().catch(() => { /* offline etc. */ });
    check();
    setInterval(check, 4 * 60 * 60 * 1000); // and every 4 hours for long streams
}
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.on('app:openDataFolder', () => shell.openPath(app.getPath('userData')));

function createWindow() {
    win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 650,
        title: "Coullsey's Lucky Wheel",
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: '#000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
        },
    });
    win.setMenuBarVisibility(false);
    win.loadURL(PANEL_URL);
    // the panel blocks closing while there are unsaved changes; without this Electron would
    // just silently refuse to close, so ask instead
    win.webContents.on('will-prevent-unload', event => {
        const choice = dialog.showMessageBoxSync(win, {
            type: 'question',
            buttons: ['Close without saving', 'Stay'],
            defaultId: 1,
            cancelId: 1,
            title: "Coullsey's Lucky Wheel",
            message: 'You have unsaved changes',
            detail: 'Close anyway and lose them? Choose Stay, then press Save, to keep them.',
        });
        if (choice === 0) event.preventDefault(); // let it close
    });
    // links that open new windows (e.g. the overlay's "Open") go to the normal browser
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
});

app.whenReady().then(async () => {
    const dir = dataDir();
    logToFile(dir);
    importOldFolder(dir);

    if (!(await portFree(PORT))) {
        await dialog.showMessageBox({
            type: 'error',
            title: "Coullsey's Lucky Wheel",
            message: 'Port ' + PORT + ' is already in use',
            detail: 'Something else is already using the wheel\'s port. Close the old "Start Lucky Wheel" window, '
                + 'the old LuckyWheel-Tool, or any other copy of the wheel, then open this again.',
        });
        app.quit();
        return;
    }

    // the wheel server runs inside the app, saving to the data folder
    process.env.WHEEL_DATA_DIR = dir;
    process.env.PORT = String(PORT);
    require('./server.js');

    createWindow();
    setupAutoUpdates();
});

app.on('window-all-closed', () => app.quit());
