// Coullseys Lucky Wheel - webhook driven spin wheel for OBS / TikTok LIVE Studio.
// No npm install needed: only uses Node's built-in modules.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 5730;
const DRY_RUN = process.env.DRY_RUN === '1'; // log reward webhooks and keybinds instead of sending them
// Where wheels, photos and fonts are saved. The desktop app points this at its AppData folder
// so updates never touch them; running `node server.js` keeps them next to this file.
const DATA_DIR = process.env.WHEEL_DATA_DIR || __dirname;
const DATA_FILE = process.env.WHEELS_FILE || path.join(DATA_DIR, 'wheels.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMAGES_DIR = path.join(DATA_DIR, 'images'); // box photos uploaded from the Wheels screen
const FONTS_DIR = path.join(DATA_DIR, 'fonts'); // fonts uploaded from the Customize screen

const UPLOADS = {
    image: { dir: IMAGES_DIR, ext: /\.(png|jpe?g|gif|webp)$/i },
    font: { dir: FONTS_DIR, ext: /\.(ttf|otf|woff2?)$/i },
};
const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

// How the overlay looks (Customize screen). font is a built-in font name, or fontFile is an uploaded one.
const DEFAULT_LOOK = {
    font: 'Lilita One',
    fontFile: '',
    boxText: '#ffffff',
    boxOutline: '#111111',
    tagBg: '#2b2b2b',
    tagText: '#ffffff',
    prize: '#ffd23f',
    pointer: '#ff7a1a',
    rim: '#ffd23f',
    // what's written under the wheel: {prize} {user} {wheel} / {count} {s}
    showPrize: true,
    prizeText: '{prize}!',
    showQueue: true,
    queueText: '{count} more spin{s} queued',
    queueColor: '#ffffff',
    queueSize: 3.2, // % of the overlay's size
};

function validLook(look) {
    const out = { ...DEFAULT_LOOK };
    if (!look || typeof look !== 'object') return out;
    for (const [k, def] of Object.entries(DEFAULT_LOOK)) {
        const v = look[k];
        if (v === undefined) continue;
        if (k === 'font') out.font = /^[\w ]{1,60}$/.test(v) ? v : def;
        else if (k === 'fontFile') out.fontFile = safeName(v, UPLOADS.font.ext);
        else if (typeof def === 'boolean') out[k] = !!v;
        else if (typeof def === 'number') out[k] = Math.min(10, Math.max(1.5, Number(v) || def));
        else if (k === 'prizeText' || k === 'queueText') out[k] = String(v).slice(0, 80);
        else if (/^#[0-9a-f]{6}$/i.test(v)) out[k] = v;
    }
    return out;
}

// only plain file names with an allowed extension - never paths
function safeName(name, ext) {
    const n = path.basename(String(name || ''));
    return n && ext.test(n) && !n.startsWith('.') ? n : '';
}

const DEFAULT_SETTINGS = {
    spinSeconds: 7,
    resultSeconds: 4,
    alwaysVisible: false,
    postWebhooks: true,
    pressKeys: true,
    acceptWebhooks: true, // false = only manual spins from the Play screen
    sound: true,
};

// ---------- keybinds ----------
// Keybinds are saved as recorded in the browser, e.g. "Ctrl+Shift+KeyA" (KeyboardEvent.code names).
// Each maps to a Windows virtual-key code and whether it's an "extended" key.
const KEYS = {};
for (let i = 0; i < 26; i++) KEYS['Key' + String.fromCharCode(65 + i)] = [65 + i, 0];
for (let i = 0; i < 10; i++) {
    KEYS['Digit' + i] = [48 + i, 0];
    KEYS['Numpad' + i] = [96 + i, 0];
}
for (let i = 1; i <= 24; i++) KEYS['F' + i] = [111 + i, 0];
Object.assign(KEYS, {
    Space: [0x20, 0], Enter: [0x0d, 0], NumpadEnter: [0x0d, 1], Tab: [0x09, 0], Escape: [0x1b, 0], Backspace: [0x08, 0],
    Insert: [0x2d, 1], Delete: [0x2e, 1], Home: [0x24, 1], End: [0x23, 1], PageUp: [0x21, 1], PageDown: [0x22, 1],
    ArrowLeft: [0x25, 1], ArrowUp: [0x26, 1], ArrowRight: [0x27, 1], ArrowDown: [0x28, 1],
    NumpadMultiply: [0x6a, 0], NumpadAdd: [0x6b, 0], NumpadSubtract: [0x6d, 0], NumpadDecimal: [0x6e, 0], NumpadDivide: [0x6f, 1],
    Minus: [0xbd, 0], Equal: [0xbb, 0], BracketLeft: [0xdb, 0], BracketRight: [0xdd, 0], Backslash: [0xdc, 0],
    Semicolon: [0xba, 0], Quote: [0xde, 0], Comma: [0xbc, 0], Period: [0xbe, 0], Slash: [0xbf, 0], Backquote: [0xc0, 0],
});
const MODS = { Ctrl: [0xa2, 0], Shift: [0xa0, 0], Alt: [0xa4, 0] };

function parseKeybind(kb) {
    const parts = String(kb || '').split('+');
    const code = parts.pop();
    if (!KEYS[code] || parts.some(m => !MODS[m])) return null;
    return [...parts.map(m => MODS[m]), KEYS[code]];
}

// A PowerShell helper that stays open and presses keys with SendInput scan codes (works in games).
const KEY_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class KeyPresser {
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    static void Send(ushort vk, bool ext, bool up) {
        INPUT input = new INPUT();
        input.type = 1;
        input.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
        input.u.ki.dwFlags = 0x0008u | (ext ? 0x0001u : 0u) | (up ? 0x0002u : 0u);
        SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }
    public static void Press(string spec) {
        string[] keys = spec.Split(',');
        for (int i = 0; i < keys.Length; i++) { string[] k = keys[i].Split(':'); Send(ushort.Parse(k[0]), k[1] == "1", false); Thread.Sleep(25); }
        Thread.Sleep(60);
        for (int i = keys.Length - 1; i >= 0; i--) { string[] k = keys[i].Split(':'); Send(ushort.Parse(k[0]), k[1] == "1", true); Thread.Sleep(25); }
    }
}
'@
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    try { [KeyPresser]::Press($line) } catch { [Console]::Error.WriteLine($_.ToString()) }
}
`;

let keyHelper = null;
function getKeyHelper() {
    if (keyHelper) return keyHelper;
    keyHelper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(KEY_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true });
    keyHelper.stderr.on('data', d => console.log('  key press error: ' + d.toString().trim()));
    keyHelper.on('exit', () => { keyHelper = null; });
    return keyHelper;
}

function pressKeybind(kb, why) {
    const keys = parseKeybind(kb);
    if (!keys) return;
    if (DRY_RUN) {
        console.log('  [dry run] would press ' + kb);
        return;
    }
    getKeyHelper().stdin.write(keys.map(([vk, ext]) => vk + ':' + ext).join(',') + '\n');
    console.log('  -> pressed ' + kb + (why ? ' (' + why + ')' : ''));
}

function load() {
    if (fs.existsSync(DATA_FILE)) {
        const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const settings = { ...DEFAULT_SETTINGS, ...saved.settings };
        settings.look = validLook(settings.look);
        return { settings, wheels: saved.wheels || [] };
    }
    const fresh = { settings: { ...DEFAULT_SETTINGS, look: { ...DEFAULT_LOOK } }, wheels: [] };
    save(fresh);
    return fresh;
}

function save(d) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

let data = load();

// ---------- spin queue ----------
const queue = [];
let current = null;
let spinCounter = 0;
const clients = new Set();
const history = []; // newest first, shown on the Play screen

function send(res, event, payload) {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n');
}

function broadcast(event, payload) {
    for (const res of clients) send(res, event, payload);
}

function findWheel(key) {
    const k = String(key ?? '').trim().toLowerCase();
    return data.wheels.find(w => w.id.toLowerCase() === k) || data.wheels.find(w => w.name.toLowerCase() === k);
}

// Frequency is a weight: a slice with 80 is twice as likely as one with 40
function pickSlice(slices) {
    const weight = s => Math.max(0, Number(s.frequency) || 0);
    const total = slices.reduce((sum, s) => sum + weight(s), 0);
    if (total <= 0) return Math.floor(Math.random() * slices.length);
    let roll = Math.random() * total;
    for (let i = 0; i < slices.length; i++) {
        roll -= weight(slices[i]);
        if (roll < 0) return i;
    }
    return slices.length - 1;
}

// The username comes from the wheel webhook (?userName={nickname}); blank means no name is shown
function cleanName(name) {
    const n = String(name ?? '').trim();
    if (/^\{.*\}$/.test(n)) return ''; // placeholder that was never filled in
    return n.slice(0, 40);
}

// what the overlay needs to know about settings
function overlaySettings() {
    return { sound: data.settings.sound, alwaysVisible: data.settings.alwaysVisible, look: data.settings.look };
}

function spinPayload(spin) {
    return {
        spinId: spin.id,
        wheel: {
            id: spin.wheel.id,
            name: spin.wheel.name,
            display: spin.wheel.display,
            slices: spin.wheel.slices.map(s => ({ text: s.text, color: s.color, style: s.style, image: s.image, hideText: s.hideText })),
        },
        index: spin.index,
        seed: spin.seed,
        userName: spin.userName,
        spinMs: spin.spinMs,
        resultMs: spin.resultMs,
        elapsedMs: Date.now() - spin.startedAt,
        queued: queue.length,
        settings: overlaySettings(),
    };
}

async function fireWebhook(slice, spin) {
    if (!slice.webhook || !data.settings.postWebhooks) return;
    const url = slice.webhook
        .replace(/\{(nickname|userName|username)\}/g, encodeURIComponent(spin.userName));
    const body = { userName: spin.userName, wheel: spin.wheel.name, result: slice.text };
    if (DRY_RUN) {
        console.log('  [dry run] would POST ' + url + ' ' + JSON.stringify(body));
        return;
    }
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        console.log('  -> ' + url + ' (' + r.status + ')');
    } catch (err) {
        console.log('  -> ' + url + ' FAILED: ' + err.message);
    }
}

function nextSpin() {
    if (current || !queue.length) return;
    const job = queue.shift();
    const wheel = findWheel(job.wheelId);
    if (!wheel || !wheel.slices.length) return nextSpin();

    const spin = {
        id: ++spinCounter,
        wheel: JSON.parse(JSON.stringify(wheel)),
        index: pickSlice(wheel.slices),
        seed: Math.floor(Math.random() * 4294967296), // every screen uses this, so OBS and the preview spin identically
        userName: job.userName,
        spinMs: Math.max(1, Number(data.settings.spinSeconds) || 7) * 1000,
        resultMs: Math.max(0, Number(data.settings.resultSeconds) || 0) * 1000,
        startedAt: Date.now(),
    };
    current = spin;
    const slice = spin.wheel.slices[spin.index];
    console.log('Spin #' + spin.id + ': ' + (spin.userName || '(no name)') + ' -> ' + wheel.name + ' wheel, lands on "' + slice.text + '"');
    broadcast('spin', spinPayload(spin));

    setTimeout(() => {
        const entry = { time: Date.now(), userName: spin.userName, wheel: wheel.name, result: slice.text, manual: job.manual };
        history.unshift(entry);
        history.length = Math.min(history.length, 30);
        broadcast('result', entry);
        fireWebhook(slice, spin);
        if (data.settings.pressKeys) pressKeybind(slice.keybind);
    }, spin.spinMs);
    setTimeout(() => {
        current = null;
        broadcast('idle', { queued: queue.length });
        nextSpin();
    }, spin.spinMs + spin.resultMs + 600);
}

function enqueue(wheelKey, userName, manual = false) {
    const wheel = findWheel(wheelKey);
    if (!wheel) return { ok: false, error: 'No wheel with id or name "' + wheelKey + '"' };
    if (!wheel.slices.length) return { ok: false, error: 'Wheel "' + wheel.name + '" has no slices' };
    queue.push({ wheelId: wheel.id, userName: cleanName(userName), manual });
    const position = queue.length + (current ? 1 : 0);
    broadcast('queue', { queued: queue.length });
    nextSpin();
    return { ok: true, wheel: wheel.name, userName: cleanName(userName), position };
}

// ---------- http ----------
function readBody(req) {
    return new Promise(resolve => {
        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
            if (raw.length > 1e6) req.destroy();
        });
        req.on('end', () => {
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve(Object.fromEntries(new URLSearchParams(raw)));
            }
        });
    });
}

function json(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
}

function serveFile(res, file, type) {
    fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
        if (err) {
            res.writeHead(404);
            return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(buf);
    });
}

function validWheels(wheels) {
    if (!Array.isArray(wheels)) return null;
    const seen = new Set();
    const out = [];
    for (const w of wheels) {
        const id = String(w.id ?? '').trim();
        if (!id || seen.has(id)) return null;
        seen.add(id);
        out.push({
            id,
            name: String(w.name ?? '').trim() || 'Wheel ' + id,
            display: w.display === 'bar' ? 'bar' : 'wheel', // roulette wheel or LuckyWheel-Tool style bar
            slices: (Array.isArray(w.slices) ? w.slices : []).map(s => ({
                text: String(s.text ?? ''),
                color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#1c1c1c',
                style: ['solid', 'ring', 'rainbow'].includes(s.style) ? s.style : 'solid',
                frequency: Math.max(0, Number(s.frequency) || 0),
                webhook: String(s.webhook ?? '').trim(),
                keybind: parseKeybind(s.keybind) ? String(s.keybind) : '',
                image: safeName(s.image, UPLOADS.image.ext),
                hideText: !!s.hideText, // for photos that already have the words on them
            })),
        });
    }
    return out;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';

    // log anything that isn't the control panel / overlay, so you can see exactly what trigger apps send
    const panelRequest = route === '/' || /^\/(editor|overlay|events|api\/|sounds\/|logo|images\/|fonts\/|favicon)/.test(route);
    if (!panelRequest) {
        console.log('<- ' + req.method + ' ' + req.url + '  (from ' + (req.headers['user-agent'] || 'unknown app') + ')');
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
    }

    // Trigger: /wheel?id=2&userName={nickname}  (GET or POST, same as the old tool)
    if (route === '/wheel') {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const q = Object.fromEntries(url.searchParams);
        const p = { ...body, ...q };
        const wheelKey = p.id ?? p.wheel ?? p.name;
        // first real name from the link or the body - apps fill in different placeholders
        // (e.g. DrewTok fills {user} in its body but leaves {nickname} in the link as-is)
        const names = [q.userName, q.username, q.nickname, q.user, body.userName, body.username, body.nickname, body.user];
        const userName = names.find(n => cleanName(n)) ?? '';
        if (!data.settings.acceptWebhooks) {
            console.log('Ignored webhook for ' + cleanName(userName) + ' (automatic spins are off)');
            return json(res, 503, { ok: false, error: 'Automatic spins are turned off on the Play screen' });
        }
        const result = enqueue(wheelKey, userName);
        console.log(result.ok ? 'Queued ' + result.userName + ' on ' + result.wheel + ' (position ' + result.position + ')' : 'Rejected: ' + result.error);
        return json(res, result.ok ? 200 : 404, result);
    }

    if (route === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        send(res, 'hello', { queued: queue.length, spinning: !!current, history, settings: overlaySettings(), wheel: data.wheels[0] || null });
        if (current) send(res, 'spin', spinPayload(current));
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
            clearInterval(ping);
            clients.delete(res);
        });
        return;
    }

    if (route === '/api/wheels' && req.method === 'GET') {
        return json(res, 200, { ...data, port: PORT, queued: queue.length, spinning: !!current, history });
    }

    // Manual spin from the Play screen - works even when automatic spins are off
    if (route === '/api/spin' && req.method === 'POST') {
        const body = await readBody(req);
        const result = enqueue(body.id, body.userName, true);
        console.log(result.ok ? 'Manual spin on ' + result.wheel : 'Rejected: ' + result.error);
        return json(res, result.ok ? 200 : 404, result);
    }

    // Test a keybind: presses it after 3 seconds so there's time to click into the game
    if (route === '/api/test-key' && req.method === 'POST') {
        const body = await readBody(req);
        if (!parseKeybind(body.keybind)) return json(res, 400, { ok: false, error: 'That keybind is not valid' });
        getKeyHelper();
        setTimeout(() => pressKeybind(body.keybind, 'test'), 3000);
        return json(res, 200, { ok: true });
    }

    // Switch a wheel between the roulette wheel and the bar straight away, without pressing Save
    if (route === '/api/display' && req.method === 'POST') {
        const body = await readBody(req);
        const wheel = findWheel(body.id);
        if (!wheel) return json(res, 404, { ok: false, error: 'No wheel with id "' + body.id + '"' });
        wheel.display = body.display === 'bar' ? 'bar' : 'wheel';
        save(data);
        broadcast('display', { id: wheel.id, display: wheel.display });
        console.log(wheel.name + ' now shows as a ' + wheel.display);
        return json(res, 200, { ok: true, id: wheel.id, display: wheel.display });
    }

    // Turn automatic (webhook) spins on/off straight away, without pressing Save
    if (route === '/api/auto' && req.method === 'POST') {
        const body = await readBody(req);
        data.settings.acceptWebhooks = !!body.on;
        save(data);
        broadcast('auto', { on: data.settings.acceptWebhooks });
        console.log('Automatic spins ' + (data.settings.acceptWebhooks ? 'ON' : 'OFF'));
        return json(res, 200, { ok: true, on: data.settings.acceptWebhooks });
    }

    if (route === '/api/wheels' && req.method === 'POST') {
        const body = await readBody(req);
        const wheels = validWheels(body.wheels);
        if (!wheels) return json(res, 400, { ok: false, error: 'Every wheel needs a unique id' });
        const settings = { ...DEFAULT_SETTINGS, ...data.settings, ...body.settings };
        settings.look = validLook(settings.look);
        data = { settings, wheels };
        save(data);
        broadcast('settings', { ...overlaySettings(), wheel: data.wheels[0] || null });
        console.log('Saved ' + wheels.length + ' wheels');
        if (!DRY_RUN && wheels.some(w => w.slices.some(s => s.keybind))) getKeyHelper();
        return json(res, 200, { ok: true });
    }

    // Upload a box photo or a font: POST /api/upload?kind=image|font&name=file.png with the file as the body
    if (route === '/api/upload' && req.method === 'POST') {
        const kind = UPLOADS[url.searchParams.get('kind')];
        const name = kind && safeName(url.searchParams.get('name'), kind.ext);
        if (!name) return json(res, 400, { ok: false, error: 'That file type isn\'t allowed' });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 25 * 1024 * 1024) return json(res, 413, { ok: false, error: 'File is too big (25 MB max)' });
            chunks.push(chunk);
        }
        fs.mkdirSync(kind.dir, { recursive: true });
        // keep the original name, adding a number if a different file already has it
        const ext = path.extname(name);
        const base = name.slice(0, -ext.length).replace(/[^\w\- ]/g, '_').slice(0, 60) || 'file';
        let file = base + ext;
        for (let i = 2; fs.existsSync(path.join(kind.dir, file)); i++) file = base + ' (' + i + ')' + ext;
        fs.writeFileSync(path.join(kind.dir, file), Buffer.concat(chunks));
        console.log('Uploaded ' + url.searchParams.get('kind') + ': ' + file);
        return json(res, 200, { ok: true, name: file });
    }

    if (route === '/api/fonts' && req.method === 'GET') {
        const files = fs.existsSync(FONTS_DIR) ? fs.readdirSync(FONTS_DIR).filter(f => UPLOADS.font.ext.test(f)) : [];
        return json(res, 200, { fonts: files });
    }

    // Uploaded photos and fonts
    const upload = route.match(/^\/(images|fonts)\/(.+)$/);
    if (upload) {
        const kind = upload[1] === 'images' ? UPLOADS.image : UPLOADS.font;
        const name = safeName(decodeURIComponent(upload[2]), kind.ext);
        if (!name) {
            res.writeHead(404);
            return res.end('Not found');
        }
        return fs.readFile(path.join(kind.dir, name), (err, buf) => {
            if (err) {
                res.writeHead(404);
                return res.end('Not found');
            }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
            res.end(buf);
        });
    }

    if (route === '/api/clear-queue' && req.method === 'POST') {
        queue.length = 0;
        broadcast('queue', { queued: 0 });
        return json(res, 200, { ok: true });
    }

    // Sounds and logo: a file with the same name in the data folder replaces the built-in one
    const MEDIA = {
        '/sounds/spin': ['Wheel Spin.mp3', 'audio/mpeg'],
        '/sounds/ding': ['Ding.mp3', 'audio/mpeg'],
        '/logo': ['Coullsey Wheel.png', 'image/png'],
    };
    if (MEDIA[route]) {
        const [name, type] = MEDIA[route];
        const own = path.join(DATA_DIR, name);
        return fs.readFile(fs.existsSync(own) ? own : path.join(__dirname, name), (err, buf) => {
            if (err) {
                res.writeHead(404);
                return res.end('Not found');
            }
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
            res.end(buf);
        });
    }

    if (route === '/' || route === '/editor') return serveFile(res, 'editor.html', 'text/html; charset=utf-8');
    if (route === '/overlay') return serveFile(res, 'overlay.html', 'text/html; charset=utf-8');

    res.writeHead(404);
    res.end('Not found');
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.log('Port ' + PORT + ' is already in use. Close the old LuckyWheel-Tool (or anything else on that port) and try again.');
        process.exit(1);
    }
    throw err;
});

server.listen(PORT, () => {
    console.log('=== COULLSEYS LUCKY WHEEL ===');
    console.log('Control panel : http://localhost:' + PORT + '/');
    console.log('OBS overlay   : http://localhost:' + PORT + '/overlay');
    console.log('');
    for (const w of data.wheels) {
        console.log('  ' + w.name.padEnd(12) + ' http://localhost:' + PORT + '/wheel?id=' + w.id + '&userName={nickname}');
    }
    if (DRY_RUN) console.log('\nDRY RUN: reward webhooks and keybinds are logged, not sent');
    // start the key helper now so the first keybind isn't delayed
    else if (data.wheels.some(w => w.slices.some(s => s.keybind))) getKeyHelper();
    console.log('\nWaiting for spins...');
});
