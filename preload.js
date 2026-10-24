const { contextBridge, ipcRenderer } = require('electron');

// App version + auto updates (main.js does the checking/downloading), same as Gift Looper.
// Only exists inside the desktop app - the panel in a normal browser just doesn't show these.
contextBridge.exposeInMainWorld('updateAPI', {
    getVersion: () => ipcRenderer.invoke('app:version'),
    // cb({ state: 'idle' | 'downloading' | 'ready', percent, version })
    onStatus: cb => {
        ipcRenderer.on('update:status', (evt, st) => cb(st));
        ipcRenderer.invoke('update:getStatus').then(cb);
    },
    install: () => ipcRenderer.send('update:install'),
    // Manual check. Returns { result: 'dev' | 'ready' | 'available' | 'latest' | 'error', version, error }.
    check: () => ipcRenderer.invoke('update:check'),
    openDataFolder: () => ipcRenderer.send('app:openDataFolder'),
});
