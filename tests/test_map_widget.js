'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const zlib = require('node:zlib');

class ClassList {
    constructor() {
        this.values = new Set();
    }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
    toggle(value, force) {
        const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
        if (enabled) this.values.add(value);
        else this.values.delete(value);
        return enabled;
    }
}

class Element {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.dataset = {};
        this.style = {};
        this.hidden = false;
        this.disabled = false;
        this.textContent = '';
        this.value = '0';
        this.max = '0';
        this.children = [];
        this.listeners = {};
        this.attributes = {};
        this.classList = new ClassList();
    }
    addEventListener(type, callback) {
        (this.listeners[type] ||= []).push(callback);
    }
    dispatch(type, event = {}) {
        event.target ||= this;
        event.preventDefault ||= () => {};
        for (const callback of this.listeners[type] || []) callback(event);
    }
    click() { this.dispatch('click'); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    focus() {}
    closest(selector) { return selector === 'button' && this.tagName === 'BUTTON' ? this : null; }
    setPointerCapture() {}
    getBoundingClientRect() {
        return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
    }
    querySelectorAll(selector) {
        const found = [];
        const visit = element => {
            if (selector === '[data-cepm-layer-key]' && element.dataset.cepmLayerKey) {
                found.push(element);
            }
            for (const child of element.children || []) visit(child);
        };
        visit(this);
        return found;
    }
}

const expectWebgl = process.env.CEPM_DISABLE_WEBGL !== '1';
const counters = { draws: 0, textures: 0, fallbackImages: 0, strokes: 0, labels: 0 };

function make2dContext() {
    return {
        setTransform() {}, clearRect() {}, fillRect() {}, save() {}, restore() {},
        translate() {}, scale() {}, drawImage() { counters.fallbackImages += 1; },
        getImageData() { return { data: new Uint8ClampedArray([128, 0, 128, 244]) }; },
        measureText(text) { return { width: String(text).length * 6 }; },
        strokeText() {},
        fillText() { counters.labels += 1; },
        stroke() { counters.strokes += 1; },
        set font(value) {}, set textAlign(value) {}, set textBaseline(value) {},
        set lineJoin(value) {}, set lineCap(value) {}, set strokeStyle(value) {},
        set fillStyle(value) {}, set lineWidth(value) {}, set globalAlpha(value) {},
        set imageSmoothingEnabled(value) {}, set imageSmoothingQuality(value) {}
    };
}

function makeWebglContext() {
    const gl = {
        VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
        ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TEXTURE0: 8, TEXTURE_2D: 9,
        TEXTURE_MIN_FILTER: 10, TEXTURE_MAG_FILTER: 11, LINEAR: 12,
        TEXTURE_WRAP_S: 13, TEXTURE_WRAP_T: 14, CLAMP_TO_EDGE: 15,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL: 16, RGBA: 17, UNSIGNED_BYTE: 18,
        TRIANGLE_STRIP: 19,
        createShader() { return {}; }, shaderSource() {}, compileShader() {},
        getShaderParameter() { return true; }, deleteShader() {},
        createProgram() { return {}; }, attachShader() {}, linkProgram() {},
        getProgramParameter() { return true; }, useProgram() {},
        createBuffer() { return {}; }, bindBuffer() {}, bufferData() {},
        getAttribLocation(program, name) { return name === 'aPosition' ? 0 : 1; },
        enableVertexAttribArray() {}, vertexAttribPointer() {},
        createTexture() { return {}; }, activeTexture() {}, bindTexture() {},
        texParameteri() {}, getUniformLocation() { return {}; }, uniform1i() {},
        pixelStorei() {},
        texImage2D() { counters.textures += 1; },
        viewport() {}, uniform1f() {}, uniform2f() {},
        drawArrays() { counters.draws += 1; }
    };
    return gl;
}

class Canvas extends Element {
    constructor(kind) {
        super('canvas');
        this.kind = kind;
        this.width = 300;
        this.height = 150;
        this.context2d = make2dContext();
        this.contextWebgl = kind === 'weather' && expectWebgl ? makeWebglContext() : null;
    }
    getContext(type) {
        if (type === 'webgl') return this.contextWebgl;
        if (type === '2d') return this.context2d;
        return null;
    }
}

const elements = {};
const selectors = [
    'menu-toggle', 'menu-close', 'layer-menu', 'layer-grid', 'current-layer',
    'previous', 'play', 'next', 'validity', 'lead', 'run', 'generated', 'stale',
    'viewport', 'map-title', 'map-run', 'map-date', 'loading', 'error', 'slider',
    'legend', 'zoom-in', 'zoom-out', 'reset', 'fullscreen', 'zoom-level',
    'probe', 'probe-value', 'probe-label'
];
for (const name of selectors) elements[name] = new Element(name.includes('zoom') || ['previous', 'play', 'next', 'reset', 'fullscreen', 'menu-toggle', 'menu-close'].includes(name) ? 'button' : 'div');
elements['layer-menu'].hidden = true;
elements.error.hidden = true;
elements.stale.hidden = true;
elements.probe.hidden = true;
elements.probe.offsetWidth = 170;
elements.probe.offsetHeight = 54;
elements.viewport.clientWidth = 1000;
elements.viewport.clientHeight = 745;
elements.weather = new Canvas('weather');
elements.vectors = new Canvas('vectors');
elements.labels = new Canvas('labels');

const app = new Element('section');
app.dataset = {
    baseUrl: 'https://example.test/data', variable: 'temperature',
    timezone: 'Europe/Paris', moduleVersion: '1.0.0', animation: '1'
};
app.querySelector = selector => {
    const match = selector.match(/^\[data-cepm-([^\]]+)\]$/);
    return match ? elements[match[1]] : null;
};

const documentListeners = {};
const documentMock = {
    readyState: 'complete', fullscreenElement: null,
    querySelectorAll(selector) { return selector === '[data-cepm-app]' ? [app] : []; },
    createElement(tagName) {
        return String(tagName).toLowerCase() === 'canvas'
            ? new Canvas('sampler') : new Element(tagName);
    },
    addEventListener(type, callback) { (documentListeners[type] ||= []).push(callback); },
    exitFullscreen() { this.fullscreenElement = null; }
};

const manifest = {
    status: 'ok', generated_at: '2026-08-21T06:30:00Z',
    run_time: '2026-08-21T03:00:00Z',
    bounds: { south: 38, west: -12, north: 57, east: 18 },
    overlay: 'maps/frontieres.svg', places: 'maps/communes.json',
    layers: {
        temperature: {
            label: 'Température à 2 m', unit: '°C', group: 'Températures',
            decimals: 1, transparent_below: null, discrete: false,
            stops: [{ value: 0, color: '#0000ff' }, { value: 30, color: '#ff0000' }]
        }
    },
    steps: [{
        lead_hour: 7, valid_time: '2026-08-21T10:00:00Z',
        files: { temperature: 'maps/temperature/007.webp' },
        probes: { temperature: 'maps/values/temperature/007.hkv.gz' },
        vectors: { temperature: 'maps/vectors/temperature/007.svg' }
    }]
};
const places = { places: [['Paris', 2100000, 48.8566, 2.3522]] };
const svg = '<svg viewBox="0 0 2200 1640"><path d="M0,0 L20,20" stroke="#222" stroke-width="0.8"/><path d="M0,0 L30,30" stroke="#111" stroke-width="1.45"/><path d="M0,0 L40,40" stroke="#000" stroke-width="2"/></svg>';

function makeProbeBuffer(value) {
    const buffer = new ArrayBuffer(16 + 2 * 2 * 2);
    const view = new DataView(buffer);
    for (const [index, letter] of Array.from('CEV1').entries()) {
        view.setUint8(index, letter.charCodeAt(0));
    }
    view.setUint16(4, 2, true);
    view.setUint16(6, 2, true);
    view.setFloat32(8, 0, true);
    view.setFloat32(12, 30, true);
    const code = Math.round(value / 30 * 65534);
    for (let index = 0; index < 4; index += 1) {
        view.setUint16(16 + index * 2, code, true);
    }
    return buffer;
}

const probeBuffer = zlib.gzipSync(Buffer.from(makeProbeBuffer(22.5)));

function response(body) {
    return {
        ok: true, status: 200,
        json: async () => body,
        text: async () => String(body),
        arrayBuffer: async () => {
            if (body instanceof ArrayBuffer) return body;
            if (ArrayBuffer.isView(body)) {
                return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
            }
            return body;
        }
    };
}
async function fetchMock(url) {
    if (String(url).includes('index.json')) return response(manifest);
    if (String(url).includes('communes.json')) return response(places);
    if (String(url).includes('frontieres.svg')) return response(svg);
    if (String(url).includes('/vectors/')) return response(svg);
    if (String(url).includes('.hkv')) return response(probeBuffer);
    throw new Error(`URL inattendue: ${url}`);
}

class ImageMock {
    constructor() {
        this.naturalWidth = 2200;
        this.naturalHeight = 1640;
        this.width = 2200;
        this.height = 1640;
    }
    set src(value) {
        this._src = value;
        setImmediate(() => { if (this.onload) this.onload(); });
    }
    get src() { return this._src; }
}
class Path2DMock { constructor(value) { this.value = value; } }
class DOMParserMock {
    parseFromString() {
        const pathNodes = [
            ['#222', '0.8'], ['#111', '1.45'], ['#000', '2']
        ].map(([stroke, width]) => ({
            getAttribute(name) {
                return { d: 'M0,0 L20,20', stroke, 'stroke-width': width }[name] ?? null;
            }
        }));
        return {
            documentElement: {
                getAttribute(name) { return name === 'viewBox' ? '0 0 2200 1640' : null; },
                querySelectorAll(selector) { return selector === 'path' ? pathNodes : []; }
            }
        };
    }
}

const windowListeners = {};
let nextFrame = 1;
const windowMock = {
    document: documentMock, devicePixelRatio: 1, Path2D: Path2DMock,
    DecompressionStream,
    matchMedia() { return { matches: false }; },
    requestAnimationFrame(callback) {
        const id = nextFrame++;
        setImmediate(() => callback(Date.now()));
        return id;
    },
    cancelAnimationFrame() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener(type, callback) { (windowListeners[type] ||= []).push(callback); }
};

const context = {
    window: windowMock, document: documentMock, fetch: fetchMock, Image: ImageMock,
    Path2D: Path2DMock, DOMParser: DOMParserMock, Intl, Date, Math, Map, Set,
    Array, Number, String, Boolean, Promise, Error, DataView, ArrayBuffer,
    Uint8Array, Uint8ClampedArray, Blob, Response, console, setTimeout,
    clearTimeout, setInterval, clearInterval, setImmediate
};

const scriptPath = path.resolve(__dirname, '../wordpress/cep-ecmwf-france/assets/cep-map.js');
vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), context, { filename: scriptPath });

(async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(elements.error.hidden, true, elements.error.textContent);
    assert.equal(elements.loading.hidden, true);
    assert.equal(elements['zoom-level'].textContent, '100 %');
    if (expectWebgl) {
        assert.ok(counters.textures >= 1, 'La texture météo WebGL n’a pas été chargée');
        assert.ok(counters.draws >= 1, 'La carte WebGL n’a pas été dessinée');
    } else {
        assert.ok(counters.fallbackImages >= 1, 'Le rendu Canvas de secours n’a pas été dessiné');
    }
    assert.ok(counters.strokes >= 6, 'Les frontières et vecteurs météo n’ont pas été dessinés');
    assert.ok(counters.labels >= 1, 'Les noms de communes n’ont pas été dessinés');

    elements.viewport.dispatch('pointermove', {
        pointerId: 0, pointerType: 'mouse', clientX: 500, clientY: 370
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(elements.probe.hidden, false, 'La valeur au survol reste masquée');
    assert.match(elements['probe-value'].textContent, /22,5\s°C/);
    assert.equal(elements['probe-label'].textContent, 'Température à 2 m');
    elements.viewport.dispatch('pointerleave', { pointerId: 0, pointerType: 'mouse' });
    assert.equal(elements.probe.hidden, true);

    app.dispatch('cepm:focus-location', {
        detail: { latitude: 42.699, longitude: 2.9045, scale: 32 }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(elements['zoom-level'].textContent, '3200 %');
    elements.reset.click();
    await new Promise(resolve => setTimeout(resolve, 20));

    elements['zoom-in'].click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(elements['zoom-level'].textContent, '150 %');

    elements.viewport.dispatch('wheel', { deltaY: -200, clientX: 500, clientY: 370 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(Number(elements['zoom-level'].textContent.replace(/\D/g, '')) > 150);

    elements.viewport.dispatch('pointerdown', { pointerId: 1, clientX: 500, clientY: 370 });
    elements.viewport.dispatch('pointermove', { pointerId: 1, clientX: 550, clientY: 400 });
    elements.viewport.dispatch('pointerup', { pointerId: 1, clientX: 550, clientY: 400 });
    assert.equal(elements.viewport.classList.contains('is-dragging'), false);

    elements.reset.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(elements['zoom-level'].textContent, '100 %');
    assert.equal(elements['zoom-out'].disabled, true);

    elements.viewport.dispatch('pointerdown', { pointerId: 10, clientX: 400, clientY: 370 });
    elements.viewport.dispatch('pointerdown', { pointerId: 11, clientX: 600, clientY: 370 });
    elements.viewport.dispatch('pointermove', { pointerId: 11, clientX: 700, clientY: 370 });
    assert.equal(elements['zoom-level'].textContent, '150 %');
    elements.viewport.dispatch('pointerup', { pointerId: 10, clientX: 400, clientY: 370 });
    elements.viewport.dispatch('pointerup', { pointerId: 11, clientX: 700, clientY: 370 });
    assert.equal(elements.viewport.classList.contains('is-dragging'), false);
    for (let index = 0; index < 15; index += 1) elements['zoom-in'].click();
    assert.equal(elements['zoom-level'].textContent, '6400 %');
    assert.equal(elements['zoom-in'].disabled, true);
    console.log(`Widget cartographique: ${expectWebgl ? 'WebGL' : 'Canvas de secours'}, valeur au survol et zoom 6400 % OK`);
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
