(function () {
    'use strict';

    function whenReady(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback);
        } else {
            callback();
        }
    }

    function fetchJson(url) {
        return fetch(url, { cache: 'no-cache' }).then(function (response) {
            if (!response.ok) {
                throw new Error('Réponse HTTP ' + response.status);
            }
            return response.json();
        });
    }

    function fetchText(url) {
        return fetch(url, { cache: 'no-cache' }).then(function (response) {
            if (!response.ok) {
                throw new Error('Réponse HTTP ' + response.status);
            }
            return response.text();
        });
    }

    function fetchBuffer(url) {
        return fetch(url, { cache: 'no-cache' }).then(function (response) {
            if (!response.ok) {
                throw new Error('Réponse HTTP ' + response.status);
            }
            return response.arrayBuffer();
        });
    }

    function decompressIfNeeded(buffer) {
        var bytes = new Uint8Array(buffer);
        if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
            return Promise.resolve(buffer);
        }
        if (typeof window.DecompressionStream !== 'function') {
            return Promise.reject(new Error('Décompression gzip indisponible'));
        }
        var stream = new Blob([buffer]).stream().pipeThrough(
            new window.DecompressionStream('gzip')
        );
        return new Response(stream).arrayBuffer();
    }

    function clamp(value, minimum, maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    function runLabelUtc(value) {
        var date = new Date(value);
        function two(number) {
            return String(number).padStart(2, '0');
        }
        return two(date.getUTCDate()) + '/' + two(date.getUTCMonth() + 1) +
            ' ' + two(date.getUTCHours()) + 'z';
    }

    function initMap(app) {
        var baseUrl = (app.dataset.baseUrl || '').replace(/\/+$/, '');
        var requestedLayer = app.dataset.variable || 'temperature';
        var timezone = app.dataset.timezone || 'Europe/Paris';
        var moduleVersion = app.dataset.moduleVersion || '1.0.0';
        var animationEnabled = app.dataset.animation !== '0';
        var reducedMotion = window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        var menuToggle = app.querySelector('[data-cepm-menu-toggle]');
        var menuClose = app.querySelector('[data-cepm-menu-close]');
        var menuCloseLabel = app.querySelector('[data-cepm-menu-label]');
        var menuCloseIcon = app.querySelector('[data-cepm-menu-icon]');
        var layerMenu = app.querySelector('[data-cepm-layer-menu]');
        var layerGrid = app.querySelector('[data-cepm-layer-grid]');
        var currentLayerText = app.querySelector('[data-cepm-current-layer]');
        var previousButton = app.querySelector('[data-cepm-previous]');
        var playButton = app.querySelector('[data-cepm-play]');
        var nextButton = app.querySelector('[data-cepm-next]');
        var validity = app.querySelector('[data-cepm-validity]');
        var lead = app.querySelector('[data-cepm-lead]');
        var run = app.querySelector('[data-cepm-run]');
        var generated = app.querySelector('[data-cepm-generated]');
        var stale = app.querySelector('[data-cepm-stale]');
        var viewport = app.querySelector('[data-cepm-viewport]');
        var weatherCanvas = app.querySelector('[data-cepm-weather]');
        var vectorCanvas = app.querySelector('[data-cepm-vectors]');
        var labelsCanvas = app.querySelector('[data-cepm-labels]');
        var vectorContext = vectorCanvas ? vectorCanvas.getContext('2d') : null;
        var labelsContext = labelsCanvas ? labelsCanvas.getContext('2d') : null;
        var mapTitle = app.querySelector('[data-cepm-map-title]');
        var mapRun = app.querySelector('[data-cepm-map-run]');
        var mapDate = app.querySelector('[data-cepm-map-date]');
        var loading = app.querySelector('[data-cepm-loading]');
        var errorBox = app.querySelector('[data-cepm-error]');
        var slider = app.querySelector('[data-cepm-slider]');
        var timeline = app.querySelector('[data-cepm-timeline]');
        var singleTimeline = app.querySelector('[data-cepm-single-timeline]');
        var periodSelector = app.querySelector('[data-cepm-period]');
        var dualRange = app.querySelector('[data-cepm-dual-range]');
        var periodStartSlider = app.querySelector('[data-cepm-period-start]');
        var periodEndSlider = app.querySelector('[data-cepm-period-end]');
        var periodTitle = app.querySelector('[data-cepm-period-title]');
        var periodSummary = app.querySelector('[data-cepm-period-summary]');
        var periodStartLabel = app.querySelector('[data-cepm-period-start-label]');
        var periodEndLabel = app.querySelector('[data-cepm-period-end-label]');
        var legend = app.querySelector('[data-cepm-legend]');
        var zoomIn = app.querySelector('[data-cepm-zoom-in]');
        var zoomOut = app.querySelector('[data-cepm-zoom-out]');
        var reset = app.querySelector('[data-cepm-reset]');
        var fullscreen = app.querySelector('[data-cepm-fullscreen]');
        var zoomLevel = app.querySelector('[data-cepm-zoom-level]');
        var probe = app.querySelector('[data-cepm-probe]');
        var probeValue = app.querySelector('[data-cepm-probe-value]');
        var probeLabel = app.querySelector('[data-cepm-probe-label]');
        var toolButtons = app.querySelectorAll('[data-cepm-tool]');
        var toolHint = app.querySelector('[data-cepm-tool-hint]');
        var advancedTools = app.querySelector('[data-cepm-advanced-tools]');
        var captureButton = app.querySelector('[data-cepm-capture]');
        var copyButton = app.querySelector('[data-cepm-copy]');
        var diagramPopup = app.querySelector('[data-cepm-diagram-popup]');
        var diagramTitle = app.querySelector('[data-cepm-diagram-title]');
        var diagramBody = app.querySelector('[data-cepm-diagram-body]');
        var diagramStatus = app.querySelector('[data-cepm-diagram-status]');
        var diagramClose = app.querySelector('[data-cepm-diagram-close]');

        var manifest = null;
        var currentLayer = requestedLayer;
        var currentStep = 0;
        var loadToken = 0;
        var timer = null;
        var transform = { scale: 1, x: 0, y: 0 };
        var activePointers = new Map();
        var gesture = null;
        var places = [];
        var placeBuckets = new Map();
        var baseVectorDefinition = null;
        var weatherVectorDefinition = null;
        var vectorLoadToken = 0;
        var currentWeatherImage = null;
        var currentProbe = null;
        var probeLoadToken = 0;
        var samplerCanvas = document.createElement('canvas');
        var samplerContext = samplerCanvas.getContext ? samplerCanvas.getContext(
            '2d', { willReadFrequently: true }
        ) : null;
        var samplerReady = false;
        var hoverFrame = null;
        var lastHover = null;
        var renderFrame = null;
        var webgl = null;
        var fallbackContext = null;
        var maxScale = 64;
        var pendingFocus = null;
        var focusedLocation = null;
        var toolMode = null;
        var pinnedEnabled = false;
        var pinnedPoint = null;
        var tapStart = null;
        var departmentCache = new Map();
        var diagramLoadToken = 0;
        var periodStart = 0;
        var periodEnd = 0;
        var periodTimer = null;
        var periodProbeCache = new Map();

        var validityFormat;
        var runFormat;
        var mapDateFormat;
        try {
            validityFormat = new Intl.DateTimeFormat('fr-FR', {
                timeZone: timezone,
                weekday: 'short',
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            });
            runFormat = new Intl.DateTimeFormat('fr-FR', {
                timeZone: timezone,
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            });
            mapDateFormat = new Intl.DateTimeFormat('fr-FR', {
                timeZone: timezone,
                weekday: 'long',
                day: '2-digit',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            });
        } catch (formatError) {
            validityFormat = new Intl.DateTimeFormat('fr-FR');
            runFormat = validityFormat;
            mapDateFormat = validityFormat;
        }

        function resolvePath(path) {
            if (/^(?:https?:\/\/|data:|blob:)/i.test(path || '')) {
                return path;
            }
            return baseUrl + '/' + String(path || '').replace(/^\/+/, '');
        }

        function versioned(path) {
            if (/^(?:data:|blob:)/i.test(path || '')) {
                return String(path);
            }
            var separator = String(path).indexOf('?') === -1 ? '?' : '&';
            var version = manifest && manifest.generated_at ? manifest.generated_at : Date.now();
            return resolvePath(path) + separator + 'v=' + encodeURIComponent(version);
        }

        function showError(message) {
            stopAnimation();
            loading.hidden = true;
            errorBox.textContent = message;
            errorBox.hidden = false;
        }

        function clearError() {
            errorBox.hidden = true;
            errorBox.textContent = '';
        }

        function parseProbe(buffer) {
            if (!buffer || buffer.byteLength < 16) {
                throw new Error('grille de valeurs tronquée');
            }
            var view = new DataView(buffer);
            var signature = String.fromCharCode(
                view.getUint8(0),
                view.getUint8(1),
                view.getUint8(2),
                view.getUint8(3)
            );
            var width = view.getUint16(4, true);
            var height = view.getUint16(6, true);
            if (signature !== 'CEV1' || !width || !height ||
                    buffer.byteLength < 16 + width * height * 2) {
                throw new Error('grille de valeurs invalide');
            }
            return {
                view: view,
                width: width,
                height: height,
                minimum: view.getFloat32(8, true),
                maximum: view.getFloat32(12, true)
            };
        }

        function probeCell(grid, x, y) {
            if (grid.values) {
                var stored = grid.values[y * grid.width + x];
                return Number.isFinite(stored) ? stored : null;
            }
            var code = grid.view.getUint16(
                16 + (y * grid.width + x) * 2,
                true
            );
            if (code === 65535) {
                return null;
            }
            return grid.minimum + code / 65534 *
                (grid.maximum - grid.minimum);
        }

        function sampleProbe(grid, u, v) {
            if (!grid) {
                return null;
            }
            var x = clamp(u, 0, 1) * (grid.width - 1);
            var y = clamp(v, 0, 1) * (grid.height - 1);
            var x0 = Math.floor(x);
            var y0 = Math.floor(y);
            var x1 = Math.min(x0 + 1, grid.width - 1);
            var y1 = Math.min(y0 + 1, grid.height - 1);
            var fx = x - x0;
            var fy = y - y0;
            var samples = [
                [x0, y0, (1 - fx) * (1 - fy)],
                [x1, y0, fx * (1 - fy)],
                [x0, y1, (1 - fx) * fy],
                [x1, y1, fx * fy]
            ];
            var total = 0;
            var weight = 0;
            samples.forEach(function (entry) {
                var value = probeCell(grid, entry[0], entry[1]);
                if (value === null || entry[2] <= 0) {
                    return;
                }
                total += value * entry[2];
                weight += entry[2];
            });
            return weight > 0 ? total / weight : null;
        }

        function probeValues(grid) {
            if (grid.values) {
                return grid.values;
            }
            var count = grid.width * grid.height;
            var values = new Float32Array(count);
            var span = grid.maximum - grid.minimum;
            for (var index = 0; index < count; index += 1) {
                var code = grid.view.getUint16(16 + index * 2, true);
                values[index] = code === 65535
                    ? NaN
                    : grid.minimum + code / 65534 * span;
            }
            grid.values = values;
            return values;
        }

        function colourForValue(value, layer) {
            if (!Number.isFinite(value) || !layer ||
                    !Array.isArray(layer.stops) || layer.stops.length < 2 ||
                    (layer.transparent_below !== null &&
                    layer.transparent_below !== undefined &&
                    value < Number(layer.transparent_below))) {
                return [0, 0, 0, 0];
            }
            var stops = layer.stops;
            var clipped = clamp(
                value,
                Number(stops[0].value),
                Number(stops[stops.length - 1].value)
            );
            var upper = 1;
            while (upper < stops.length &&
                    clipped >= Number(stops[upper].value)) {
                upper += 1;
            }
            upper = clamp(upper, 1, stops.length - 1);
            var lower = upper - 1;
            var first = parseColour(stops[lower].color);
            var colour = first;
            if (!layer.discrete) {
                var second = parseColour(stops[upper].color);
                var lowValue = Number(stops[lower].value);
                var highValue = Number(stops[upper].value);
                var fraction = highValue === lowValue ? 0 :
                    clamp((clipped - lowValue) / (highValue - lowValue), 0, 1);
                colour = [
                    Math.round(first[0] + (second[0] - first[0]) * fraction),
                    Math.round(first[1] + (second[1] - first[1]) * fraction),
                    Math.round(first[2] + (second[2] - first[2]) * fraction)
                ];
            }
            return [
                colour[0], colour[1], colour[2],
                clamp(Number(layer.opacity) || 244, 0, 255)
            ];
        }

        function renderProbeGrid(grid, layer) {
            var canvas = document.createElement('canvas');
            canvas.width = grid.width;
            canvas.height = grid.height;
            var context = canvas.getContext('2d');
            var imageData = context.createImageData(grid.width, grid.height);
            var pixels = imageData.data;
            var values = probeValues(grid);
            for (var index = 0; index < values.length; index += 1) {
                var colour = colourForValue(values[index], layer);
                var offset = index * 4;
                pixels[offset] = colour[0];
                pixels[offset + 1] = colour[1];
                pixels[offset + 2] = colour[2];
                pixels[offset + 3] = colour[3];
            }
            context.putImageData(imageData, 0, 0);
            return canvas;
        }

        function fetchPeriodProbe(step, sourceKey) {
            var path = step && step.probes && step.probes[sourceKey];
            if (!path) {
                return Promise.reject(new Error('grille numérique absente'));
            }
            var cacheKey = versioned(path);
            if (periodProbeCache.has(cacheKey)) {
                return periodProbeCache.get(cacheKey);
            }
            var promise = fetchBuffer(cacheKey)
                .then(decompressIfNeeded)
                .then(parseProbe)
                .catch(function (error) {
                    periodProbeCache.delete(cacheKey);
                    throw error;
                });
            periodProbeCache.set(cacheKey, promise);
            while (periodProbeCache.size > 18) {
                periodProbeCache.delete(periodProbeCache.keys().next().value);
            }
            return promise;
        }

        function fetchProbeSeries(steps, sourceKey, progress) {
            var grids = new Array(steps.length);
            var cursor = 0;
            var completed = 0;
            function worker() {
                if (cursor >= steps.length) {
                    return Promise.resolve();
                }
                var index = cursor;
                cursor += 1;
                return fetchPeriodProbe(steps[index], sourceKey).then(function (grid) {
                    grids[index] = grid;
                    completed += 1;
                    if (progress) {
                        progress(completed, steps.length);
                    }
                    return worker();
                });
            }
            var workers = [];
            for (var index = 0; index < Math.min(5, steps.length); index += 1) {
                workers.push(worker());
            }
            return Promise.all(workers).then(function () { return grids; });
        }

        function combinePeriodGrids(grids, mode) {
            if (!grids.length) {
                throw new Error('aucune échéance dans la période');
            }
            var width = grids[0].width;
            var height = grids[0].height;
            var count = width * height;
            grids.forEach(function (grid) {
                if (grid.width !== width || grid.height !== height) {
                    throw new Error('grilles de période incompatibles');
                }
            });
            var combined = new Float32Array(count);
            combined.fill(NaN);
            if (mode === 'difference') {
                var startValues = probeValues(grids[0]);
                var endValues = probeValues(grids[grids.length - 1]);
                for (var index = 0; index < count; index += 1) {
                    if (Number.isFinite(startValues[index]) &&
                            Number.isFinite(endValues[index])) {
                        combined[index] = Math.max(
                            0, endValues[index] - startValues[index]
                        );
                    }
                }
            } else {
                grids.forEach(function (grid) {
                    var values = probeValues(grid);
                    for (var index = 0; index < count; index += 1) {
                        if (Number.isFinite(values[index]) &&
                                (!Number.isFinite(combined[index]) ||
                                values[index] > combined[index])) {
                            combined[index] = values[index];
                        }
                    }
                });
            }
            return {
                width: width,
                height: height,
                minimum: 0,
                maximum: Math.max.apply(null, grids.map(function (grid) {
                    return grid.maximum;
                })),
                values: combined
            };
        }

        function parseColour(value) {
            var clean = String(value || '').replace('#', '');
            if (!/^[0-9a-f]{6}$/i.test(clean)) {
                return [0, 0, 0];
            }
            return [
                parseInt(clean.slice(0, 2), 16),
                parseInt(clean.slice(2, 4), 16),
                parseInt(clean.slice(4, 6), 16)
            ];
        }

        function valueFromColour(red, green, blue, layer) {
            if (!layer || !Array.isArray(layer.stops) || layer.stops.length < 2) {
                return null;
            }
            var stops = layer.stops.map(function (stop) {
                return {
                    value: Number(stop.value),
                    colour: parseColour(stop.color)
                };
            });
            var target = [red, green, blue];
            var bestValue = null;
            var bestDistance = Infinity;
            for (var index = 0; index < stops.length - 1; index += 1) {
                var first = stops[index];
                var second = stops[index + 1];
                var fraction = 0;
                if (!layer.discrete) {
                    var dr = second.colour[0] - first.colour[0];
                    var dg = second.colour[1] - first.colour[1];
                    var db = second.colour[2] - first.colour[2];
                    var denominator = dr * dr + dg * dg + db * db;
                    if (denominator > 0) {
                        fraction = clamp(
                            ((target[0] - first.colour[0]) * dr +
                                (target[1] - first.colour[1]) * dg +
                                (target[2] - first.colour[2]) * db) /
                                denominator,
                            0,
                            1
                        );
                    }
                }
                var candidate = [
                    first.colour[0] + (second.colour[0] - first.colour[0]) * fraction,
                    first.colour[1] + (second.colour[1] - first.colour[1]) * fraction,
                    first.colour[2] + (second.colour[2] - first.colour[2]) * fraction
                ];
                var distance = Math.pow(target[0] - candidate[0], 2) +
                    Math.pow(target[1] - candidate[1], 2) +
                    Math.pow(target[2] - candidate[2], 2);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestValue = first.value +
                        (second.value - first.value) * fraction;
                }
            }
            return bestValue;
        }

        function prepareImageSampler(source) {
            samplerReady = false;
            if (!samplerContext || !source) {
                return;
            }
            var width = Number(source.naturalWidth || source.width ||
                (manifest && manifest.width) || 0);
            var height = Number(source.naturalHeight || source.height ||
                (manifest && manifest.height) || 0);
            if (!width || !height) {
                return;
            }
            try {
                samplerCanvas.width = width;
                samplerCanvas.height = height;
                samplerContext.clearRect(0, 0, width, height);
                samplerContext.drawImage(source, 0, 0, width, height);
                samplerReady = true;
            } catch (samplingError) {
                samplerReady = false;
            }
        }

        function samplePalette(u, v, layer) {
            if (!samplerReady || !samplerContext) {
                return null;
            }
            var x = clamp(Math.round(u * (samplerCanvas.width - 1)),
                0, samplerCanvas.width - 1);
            var y = clamp(Math.round(v * (samplerCanvas.height - 1)),
                0, samplerCanvas.height - 1);
            try {
                var pixel = samplerContext.getImageData(x, y, 1, 1).data;
                if (pixel[3] < 12) {
                    return layer.transparent_below !== null &&
                        layer.transparent_below !== undefined ? 0 : null;
                }
                return valueFromColour(pixel[0], pixel[1], pixel[2], layer);
            } catch (samplingError) {
                samplerReady = false;
                return null;
            }
        }

        function loadProbe(step) {
            var token = ++probeLoadToken;
            currentProbe = null;
            var path = step && step.probes && step.probes[currentLayer];
            if (!path) {
                return Promise.resolve();
            }
            return fetchBuffer(versioned(path))
                .then(decompressIfNeeded)
                .then(parseProbe)
                .then(function (grid) {
                    if (token !== probeLoadToken) {
                        return;
                    }
                    currentProbe = grid;
                    if (lastHover) {
                        updateProbe(lastHover.x, lastHover.y);
                    }
                })
                .catch(function () {
                    if (token === probeLoadToken) {
                        currentProbe = null;
                    }
                });
        }

        function hideProbe() {
            lastHover = null;
            if (hoverFrame !== null && window.cancelAnimationFrame) {
                window.cancelAnimationFrame(hoverFrame);
                hoverFrame = null;
            }
            if (probe) {
                probe.hidden = true;
            }
        }

        function pointerMapPosition(clientX, clientY) {
            var box = viewport.getBoundingClientRect();
            var screenX = clientX - box.left;
            var screenY = clientY - box.top;
            var mapX = (screenX - box.width / 2 - transform.x) /
                transform.scale + box.width / 2;
            var mapY = (screenY - box.height / 2 - transform.y) /
                transform.scale + box.height / 2;
            var u = mapX / box.width;
            var v = mapY / box.height;
            if (u < 0 || u > 1 || v < 0 || v > 1) {
                return null;
            }
            return {
                screenX: screenX,
                screenY: screenY,
                u: u,
                v: v,
                width: box.width,
                height: box.height
            };
        }

        function updateProbe(clientX, clientY) {
            if (!probe || !probeValue || !probeLabel || !manifest ||
                    !currentWeatherImage) {
                hideProbe();
                return;
            }
            lastHover = { x: clientX, y: clientY };
            var position = pointerMapPosition(clientX, clientY);
            var layer = manifest.layers[currentLayer];
            if (!position || !layer) {
                probe.hidden = true;
                return;
            }
            var value = sampleProbe(currentProbe, position.u, position.v);
            var estimated = false;
            if (value === null) {
                value = samplePalette(position.u, position.v, layer);
                estimated = value !== null;
            }
            if (value === null || !Number.isFinite(value)) {
                probe.hidden = true;
                return;
            }
            var decimals = clamp(Number(layer.decimals) || 0, 0, 2);
            var formatted = Number(value).toLocaleString('fr-FR', {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            });
            probeValue.textContent = (estimated ? '≈ ' : '') + formatted +
                (layer.unit ? ' ' + layer.unit : '');
            probeLabel.textContent = layer.label || currentLayer;
            probe.hidden = false;

            var tooltipWidth = probe.offsetWidth || 170;
            var tooltipHeight = probe.offsetHeight || 54;
            var left = position.screenX + 16;
            var top = position.screenY + 16;
            if (left + tooltipWidth > position.width - 8) {
                left = position.screenX - tooltipWidth - 16;
            }
            if (top + tooltipHeight > position.height - 8) {
                top = position.screenY - tooltipHeight - 16;
            }
            probe.style.left = Math.max(8, left) + 'px';
            probe.style.top = Math.max(8, top) + 'px';
        }

        var pinnedElement = null;

        function clearPinned() {
            if (pinnedElement && pinnedElement.parentNode) {
                pinnedElement.parentNode.removeChild(pinnedElement);
            }
            pinnedElement = null;
            pinnedPoint = null;
        }

        function positionPinned() {
            if (!pinnedElement || !pinnedPoint) {
                return;
            }
            var box = viewport.getBoundingClientRect();
            var mapX = pinnedPoint.u * box.width;
            var mapY = pinnedPoint.v * box.height;
            var screenX = (mapX - box.width / 2) * transform.scale + transform.x + box.width / 2;
            var screenY = (mapY - box.height / 2) * transform.scale + transform.y + box.height / 2;
            if (screenX < -40 || screenX > box.width + 40 || screenY < -40 || screenY > box.height + 40) {
                pinnedElement.style.display = 'none';
                return;
            }
            pinnedElement.style.display = '';
            var width = pinnedElement.offsetWidth || 170;
            var height = pinnedElement.offsetHeight || 54;
            var left = screenX + 14;
            var top = screenY - height - 14;
            if (left + width > box.width - 8) {
                left = screenX - width - 14;
            }
            if (top < 8) {
                top = screenY + 14;
            }
            pinnedElement.style.left = Math.max(8, Math.min(left, box.width - width - 8)) + 'px';
            pinnedElement.style.top = Math.max(8, Math.min(top, box.height - height - 8)) + 'px';
        }

        function pinProbeAt(clientX, clientY) {
            if (!manifest || !currentWeatherImage) {
                return;
            }
            var position = pointerMapPosition(clientX, clientY);
            var layer = manifest.layers[currentLayer];
            if (!position || !layer) {
                return;
            }
            var value = sampleProbe(currentProbe, position.u, position.v);
            var estimated = false;
            if (value === null) {
                value = samplePalette(position.u, position.v, layer);
                estimated = value !== null;
            }
            if (value === null || !Number.isFinite(value)) {
                return;
            }
            clearPinned();
            var decimals = clamp(Number(layer.decimals) || 0, 0, 2);
            var formatted = Number(value).toLocaleString('fr-FR', {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            });
            pinnedElement = document.createElement('div');
            pinnedElement.className = 'cepm-probe cepm-probe-pinned';
            var strong = document.createElement('strong');
            strong.textContent = (estimated ? '≈ ' : '') + formatted + (layer.unit ? ' ' + layer.unit : '');
            var label = document.createElement('span');
            label.textContent = layer.label || currentLayer;
            var close = document.createElement('button');
            close.type = 'button';
            close.className = 'cepm-probe-pin-close';
            close.setAttribute('aria-label', 'Retirer l’épingle');
            close.textContent = '×';
            close.addEventListener('click', function (event) {
                event.stopPropagation();
                clearPinned();
            });
            pinnedElement.appendChild(strong);
            pinnedElement.appendChild(label);
            pinnedElement.appendChild(close);
            viewport.appendChild(pinnedElement);
            pinnedPoint = { u: position.u, v: position.v };
            positionPinned();
        }

        function screenToLatLon(clientX, clientY) {
            if (!manifest || !manifest.bounds) {
                return null;
            }
            var position = pointerMapPosition(clientX, clientY);
            if (!position) {
                return null;
            }
            var bounds = manifest.bounds;
            var west = Number(bounds.west);
            var east = Number(bounds.east);
            var northY = mercator(Number(bounds.north));
            var southY = mercator(Number(bounds.south));
            return {
                latitude: inverseMercator(northY - position.v * (northY - southY)),
                longitude: west + position.u * (east - west)
            };
        }

        function nearestPlace(latitude, longitude) {
            if (!placeBuckets.size) {
                return null;
            }
            var baseLat = Math.floor(latitude);
            var baseLon = Math.floor(longitude);
            var best = null;
            var bestDistance = Infinity;
            for (var dLat = -2; dLat <= 2; dLat += 1) {
                for (var dLon = -2; dLon <= 2; dLon += 1) {
                    var bucket = placeBuckets.get((baseLat + dLat) + '|' + (baseLon + dLon));
                    if (!bucket) {
                        continue;
                    }
                    for (var index = 0; index < bucket.length; index += 1) {
                        var place = bucket[index];
                        var placeLat = Number(place[2]);
                        var placeLon = Number(place[3]);
                        var dy = placeLat - latitude;
                        var dx = (placeLon - longitude) * Math.cos(latitude * Math.PI / 180);
                        var distance = dx * dx + dy * dy;
                        if (distance < bestDistance) {
                            bestDistance = distance;
                            best = place;
                        }
                    }
                }
            }
            return best;
        }

        function setToolHint(message) {
            if (!toolHint) {
                return;
            }
            toolHint.textContent = message || '';
            toolHint.hidden = !message;
        }

        function setToolMode(mode) {
            toolMode = toolMode === mode ? null : mode;
            toolButtons.forEach(function (button) {
                var active = button.dataset.cepmTool === toolMode;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            if (advancedTools) {
                advancedTools.hidden = toolMode !== 'zoom';
            }
            if (toolMode !== 'zoom') {
                pinnedEnabled = false;
                clearPinned();
            }
            if (toolMode === 'diagram') {
                setToolHint('Cliquez sur la carte pour afficher le diagramme CEP du point choisi.');
            } else {
                setToolHint('');
                closeDiagram();
            }
        }

        function fitCaptureText(context, value, maximumWidth) {
            var text = String(value || '');
            if (!context.measureText || context.measureText(text).width <= maximumWidth) {
                return text;
            }
            while (text.length > 3 && context.measureText(text + '…').width > maximumWidth) {
                text = text.slice(0, -1);
            }
            return text + '…';
        }

        function drawCaptureLegend(context, layer, width, top, footerHeight) {
            var stops = layer && Array.isArray(layer.stops) ? layer.stops : [];
            context.fillStyle = '#0d0e17';
            context.fillRect(0, top, width, footerHeight);
            context.fillStyle = '#ffffff';
            context.font = '800 13px Inter, Segoe UI, Arial, sans-serif';
            context.textAlign = 'left';
            context.fillText(
                'LÉGENDE' + (layer && layer.unit ? ' — ' + layer.unit : ''),
                16,
                top + 22
            );
            if (stops.length) {
                var legendLeft = 16;
                var legendWidth = width - 32;
                var segmentWidth = legendWidth / stops.length;
                stops.forEach(function (stop, index) {
                    var left = legendLeft + index * segmentWidth;
                    context.fillStyle = stop.color || '#777777';
                    context.fillRect(left, top + 31, Math.ceil(segmentWidth), 18);
                    context.fillStyle = '#ffffff';
                    context.font = '700 ' + (stops.length > 18 ? 8 : 9) +
                        'px Inter, Segoe UI, Arial, sans-serif';
                    context.textAlign = 'center';
                    context.fillText(String(stop.value), left + segmentWidth / 2, top + 62);
                });
            }
            context.textAlign = 'left';
            context.fillStyle = '#cdd8e6';
            context.font = '600 10px Inter, Segoe UI, Arial, sans-serif';
            var details = [
                validity ? validity.textContent : '',
                lead ? lead.textContent : '',
                'Zoom ' + Math.round(transform.scale * 100) + ' %'
            ].filter(Boolean).join(' • ');
            context.fillText(fitCaptureText(context, details, width * 0.58), 16, top + 84);
            context.textAlign = 'right';
            context.fillText(
                fitCaptureText(
                    context,
                    'ECMWF Open Data • www.alertes-meteo.com • Module v' + moduleVersion,
                    width * 0.38
                ),
                width - 16,
                top + 84
            );
            context.textAlign = 'left';
        }

        function composeCaptureCanvas() {
            if (!viewport || !currentWeatherImage) {
                return null;
            }
            var width = viewport.clientWidth;
            var height = viewport.clientHeight;
            if (!width || !height) {
                return null;
            }
            var pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            var headerHeight = 116;
            var footerHeight = 96;
            var totalHeight = headerHeight + height + footerHeight;
            var output = document.createElement('canvas');
            output.width = Math.max(1, Math.round(width * pixelRatio));
            output.height = Math.max(1, Math.round(totalHeight * pixelRatio));
            var context = output.getContext('2d');
            if (!context) {
                return null;
            }
            context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            context.fillStyle = '#073b63';
            context.fillRect(0, 0, width, headerHeight);
            context.fillStyle = '#8dd9ef';
            context.font = '800 11px Inter, Segoe UI, Arial, sans-serif';
            context.textAlign = 'left';
            context.fillText('ECMWF IFS DÉTERMINISTE • FRANCE MÉTROPOLITAINE • CEP 0,25°', 16, 22);
            context.fillStyle = '#ffffff';
            context.font = '900 24px Inter, Segoe UI, Arial, sans-serif';
            context.fillText(
                fitCaptureText(context, mapTitle ? mapTitle.textContent : 'Carte CEP', width * 0.64),
                16,
                52
            );
            context.textAlign = 'right';
            context.font = '700 11px Inter, Segoe UI, Arial, sans-serif';
            context.fillStyle = '#dce9f5';
            context.fillText(
                fitCaptureText(context, mapRun ? mapRun.textContent : '', width * 0.32),
                width - 16,
                23
            );
            context.fillText(
                fitCaptureText(context, generated ? generated.textContent : '', width * 0.32),
                width - 16,
                43
            );
            context.textAlign = 'left';
            context.fillStyle = '#ffffff';
            context.font = '800 14px Inter, Segoe UI, Arial, sans-serif';
            context.fillText(
                fitCaptureText(context, mapDate ? mapDate.textContent : '', width - 32),
                16,
                78
            );
            context.fillStyle = '#bfe8f4';
            context.font = '700 11px Inter, Segoe UI, Arial, sans-serif';
            var locationText = focusedLocation && focusedLocation.label
                ? 'Zone ciblée : ' + focusedLocation.label + ' • '
                : '';
            if (focusedLocation && Number.isFinite(Number(focusedLocation.latitude)) &&
                    Number.isFinite(Number(focusedLocation.longitude))) {
                locationText += Number(focusedLocation.latitude).toFixed(4) + '° N • ' +
                    Number(focusedLocation.longitude).toFixed(4) + '° E • ';
            }
            locationText += (validity ? validity.textContent : '') +
                (lead && lead.textContent ? ' • ' + lead.textContent : '');
            context.fillText(fitCaptureText(context, locationText, width - 32), 16, 101);

            context.fillStyle = '#a5a6b0';
            context.fillRect(0, headerHeight, width, height);
            context.save();
            context.translate(
                width / 2 + transform.x,
                headerHeight + height / 2 + transform.y
            );
            context.scale(transform.scale, transform.scale);
            context.translate(-width / 2, -height / 2);
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(currentWeatherImage, 0, 0, width, height);
            context.restore();
            context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            [vectorCanvas, labelsCanvas].forEach(function (source) {
                if (source && source.width && source.height) {
                    context.drawImage(
                        source,
                        0,
                        0,
                        source.width,
                        source.height,
                        0,
                        headerHeight,
                        width,
                        height
                    );
                }
            });
            context.fillStyle = 'rgba(3, 26, 43, .78)';
            context.fillRect(12, headerHeight + height - 31, width - 24, 22);
            context.fillStyle = '#ffffff';
            context.font = '800 11px Inter, Segoe UI, Arial, sans-serif';
            context.textAlign = 'center';
            context.fillText(
                'www.alertes-meteo.com • Carte CEP/IFS • Module v' + moduleVersion,
                width / 2,
                headerHeight + height - 16
            );
            drawCaptureLegend(
                context,
                manifest && manifest.layers ? manifest.layers[currentLayer] : null,
                width,
                headerHeight + height,
                footerHeight
            );
            return output;
        }

        function captureImage() {
            var canvas = composeCaptureCanvas();
            if (!canvas || !canvas.toBlob) {
                setToolHint('Capture indisponible pour ce navigateur.');
                return;
            }
            canvas.toBlob(function (blob) {
                if (!blob) {
                    return;
                }
                var url = URL.createObjectURL(blob);
                var link = document.createElement('a');
                var layerLabel = manifest && manifest.layers && manifest.layers[currentLayer]
                    ? manifest.layers[currentLayer].label
                    : currentLayer;
                var slug = String(layerLabel || 'cep').toLowerCase()
                    .normalize('NFD').replace(/[̀-ͯ]/g, '')
                    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                link.href = url;
                link.download = 'cep-' + (slug || 'carte') + '-' + Date.now() + '.png';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
                setToolHint('PNG téléchargé avec succès.');
            }, 'image/png');
        }

        function copyImage() {
            var canvas = composeCaptureCanvas();
            if (!canvas || !canvas.toBlob || !navigator.clipboard ||
                    typeof navigator.clipboard.write !== 'function' ||
                    typeof window.ClipboardItem !== 'function') {
                setToolHint('Copie directe indisponible : utilisez Télécharger PNG.');
                return;
            }
            canvas.toBlob(function (blob) {
                if (!blob) {
                    setToolHint('Impossible de préparer l’image.');
                    return;
                }
                var item = new window.ClipboardItem({ 'image/png': blob });
                navigator.clipboard.write([item]).then(function () {
                    setToolHint('Image copiée : vous pouvez maintenant la coller.');
                }).catch(function () {
                    setToolHint('Copie refusée par le navigateur : utilisez Télécharger PNG.');
                });
            }, 'image/png');
        }

        function closeDiagram() {
            if (diagramPopup) {
                diagramPopup.hidden = true;
            }
            diagramLoadToken += 1;
        }

        function fetchDepartmentForDiagram(code) {
            if (departmentCache.has(code)) {
                return departmentCache.get(code);
            }
            var promise = fetchJson(baseUrl + '/departements/' + code + '.json')
                .catch(function (error) {
                    departmentCache.delete(code);
                    throw error;
                });
            departmentCache.set(code, promise);
            return promise;
        }

        function positionDiagramPopup(clientX, clientY) {
            if (!diagramPopup) {
                return;
            }
            var box = viewport.getBoundingClientRect();
            var left = clientX - box.left + 14;
            var top = clientY - box.top + 14;
            var width = diagramPopup.offsetWidth || 320;
            var height = diagramPopup.offsetHeight || 220;
            if (left + width > box.width - 8) {
                left = clientX - box.left - width - 14;
            }
            if (top + height > box.height - 8) {
                top = clientY - box.top - height - 14;
            }
            diagramPopup.style.left = Math.max(8, left) + 'px';
            diagramPopup.style.top = Math.max(8, top) + 'px';
        }

        function renderDiagramChart(name, forecastRows, columnIndex, pointIndex) {
            if (!diagramBody) {
                return;
            }
            diagramBody.replaceChildren();
            var temperatures = [];
            var rains = [];
            var hourLabels = [];
            forecastRows.slice(0, 30).forEach(function (row) {
                var values = row[1] && row[1][pointIndex];
                if (!values) {
                    return;
                }
                var date = new Date(row[0]);
                var tempIndex = columnIndex.temperature_c;
                var rainIndex = columnIndex.precipitation_mm;
                temperatures.push(typeof tempIndex === 'number' ? Number(values[tempIndex]) : null);
                rains.push(typeof rainIndex === 'number' ? Number(values[rainIndex]) : 0);
                hourLabels.push(String(date.getHours()).padStart(2, '0') + 'h');
            });
            var validTemps = temperatures.filter(function (value) { return Number.isFinite(value); });
            if (!validTemps.length) {
                diagramBody.appendChild(document.createTextNode('Aucune donnée exploitable pour ce point.'));
                return;
            }
            var width = 320;
            var height = 150;
            var margin = { left: 30, right: 10, top: 14, bottom: 20 };
            var innerWidth = width - margin.left - margin.right;
            var innerHeight = height - margin.top - margin.bottom;
            var minTemp = Math.min.apply(null, validTemps);
            var maxTemp = Math.max.apply(null, validTemps);
            if (minTemp === maxTemp) {
                minTemp -= 1;
                maxTemp += 1;
            }
            var maxRain = Math.max(1, Math.max.apply(null, rains.map(function (value) {
                return Number.isFinite(value) ? value : 0;
            })));
            var svgNs = 'http://www.w3.org/2000/svg';
            var svg = document.createElementNS(svgNs, 'svg');
            svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
            svg.setAttribute('class', 'cepm-diagram-svg');
            svg.setAttribute('role', 'img');
            svg.setAttribute('aria-label', 'Diagramme CEP pour ' + name);
            var count = temperatures.length;
            var stepX = count > 1 ? innerWidth / (count - 1) : 0;

            rains.forEach(function (value, index) {
                if (!Number.isFinite(value) || value <= 0) {
                    return;
                }
                var barHeight = value / maxRain * innerHeight * 0.55;
                var rect = document.createElementNS(svgNs, 'rect');
                rect.setAttribute('x', (margin.left + index * stepX - stepX * 0.3).toFixed(1));
                rect.setAttribute('y', (margin.top + innerHeight - barHeight).toFixed(1));
                rect.setAttribute('width', Math.max(1.5, stepX * 0.6).toFixed(1));
                rect.setAttribute('height', barHeight.toFixed(1));
                rect.setAttribute('class', 'cepm-diagram-rain');
                svg.appendChild(rect);
            });

            var points = temperatures.map(function (value, index) {
                if (!Number.isFinite(value)) {
                    return null;
                }
                var x = margin.left + index * stepX;
                var y = margin.top + innerHeight * (maxTemp - value) / (maxTemp - minTemp);
                return x.toFixed(1) + ',' + y.toFixed(1);
            }).filter(Boolean);
            if (points.length > 1) {
                var polyline = document.createElementNS(svgNs, 'polyline');
                polyline.setAttribute('points', points.join(' '));
                polyline.setAttribute('class', 'cepm-diagram-temp');
                svg.appendChild(polyline);
            }

            [0, count - 1].forEach(function (index) {
                if (index < 0 || !hourLabels[index]) {
                    return;
                }
                var text = document.createElementNS(svgNs, 'text');
                text.setAttribute('x', (margin.left + index * stepX).toFixed(1));
                text.setAttribute('y', (height - 5).toFixed(1));
                text.setAttribute('text-anchor', index === 0 ? 'start' : 'end');
                text.setAttribute('class', 'cepm-diagram-axis');
                text.textContent = hourLabels[index];
                svg.appendChild(text);
            });

            [minTemp, maxTemp].forEach(function (value) {
                var y = margin.top + innerHeight * (maxTemp - value) / (maxTemp - minTemp);
                var text = document.createElementNS(svgNs, 'text');
                text.setAttribute('x', (margin.left - 4).toFixed(1));
                text.setAttribute('y', (y + 3).toFixed(1));
                text.setAttribute('text-anchor', 'end');
                text.setAttribute('class', 'cepm-diagram-axis');
                text.textContent = Math.round(value) + '°';
                svg.appendChild(text);
            });

            diagramBody.appendChild(svg);
            var caption = document.createElement('p');
            caption.className = 'cepm-diagram-caption';
            caption.textContent = 'Température (ligne) et précipitations par pas (barres) — prochaines échéances CEP.';
            diagramBody.appendChild(caption);
        }

        function openDiagramAt(clientX, clientY) {
            var point = screenToLatLon(clientX, clientY);
            if (!point || !diagramPopup) {
                return;
            }
            var place = nearestPlace(point.latitude, point.longitude);
            if (!place || place.length < 6) {
                setToolHint('Aucune commune identifiée à cet endroit — essayez un point plus proche d’une ville.');
                return;
            }
            setToolHint('Cliquez sur la carte pour afficher le diagramme CEP du point choisi.');
            var name = String(place[0]);
            var communeCode = String(place[4]);
            var departmentCode = String(place[5]);
            var token = ++diagramLoadToken;
            diagramTitle.textContent = name;
            diagramPopup.hidden = false;
            diagramBody.replaceChildren();
            if (diagramStatus) {
                diagramStatus.hidden = false;
                diagramStatus.textContent = 'Chargement du diagramme…';
                diagramBody.appendChild(diagramStatus);
            }
            positionDiagramPopup(clientX, clientY);
            fetchDepartmentForDiagram(departmentCode)
                .then(function (departmentData) {
                    if (token !== diagramLoadToken) {
                        return;
                    }
                    var communes = departmentData.communes || [];
                    var commune = null;
                    for (var index = 0; index < communes.length; index += 1) {
                        if (String(communes[index][0]) === communeCode) {
                            commune = communes[index];
                            break;
                        }
                    }
                    if (!commune) {
                        diagramBody.replaceChildren(document.createTextNode('Commune introuvable dans les données du département.'));
                        return;
                    }
                    var columns = departmentData.columns && Array.isArray(departmentData.columns.values)
                        ? departmentData.columns.values
                        : [];
                    var columnIndex = {};
                    columns.forEach(function (columnName, columnPosition) {
                        columnIndex[columnName] = columnPosition;
                    });
                    var pointIndex = Number(commune[6]);
                    var lowerTime = Date.now() - 3600000;
                    var forecastRows = (departmentData.forecast || []).filter(function (step) {
                        return Array.isArray(step) && new Date(step[0]).getTime() >= lowerTime;
                    });
                    renderDiagramChart(name, forecastRows, columnIndex, pointIndex);
                    positionDiagramPopup(clientX, clientY);
                })
                .catch(function () {
                    if (token !== diagramLoadToken) {
                        return;
                    }
                    diagramBody.replaceChildren(document.createTextNode('Impossible de charger ce diagramme pour le moment.'));
                });
        }

        function availableSteps() {
            if (!manifest || !Array.isArray(manifest.steps)) {
                return [];
            }
            return manifest.steps.filter(function (step) {
                return step && step.files && step.files[currentLayer];
            });
        }

        function initialStep(steps) {
            var threshold = Date.now() - 60 * 60 * 1000;
            for (var index = 0; index < steps.length; index += 1) {
                if (new Date(steps[index].valid_time).getTime() >= threshold) {
                    return index;
                }
            }
            return 0;
        }

        function setMenuOpen(open) {
            layerMenu.hidden = !open;
            menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (menuClose) {
                menuClose.hidden = false;
                menuClose.setAttribute('aria-expanded', open ? 'true' : 'false');
                menuClose.setAttribute(
                    'aria-label',
                    open ? 'Replier le menu des cartes' : 'Déplier le menu des cartes'
                );
            }
            if (menuCloseLabel) {
                menuCloseLabel.textContent = open ? 'Replier' : 'Déplier';
            }
            if (menuCloseIcon) {
                menuCloseIcon.textContent = open ? '⌃' : '⌄';
            }
            app.classList.toggle('is-layer-menu-open', open);
        }

        function refreshLayerMenu() {
            var current = manifest.layers[currentLayer];
            currentLayerText.textContent = current ? current.label : 'Choisir une carte';
            layerGrid.querySelectorAll('[data-cepm-layer-key]').forEach(function (button) {
                var active = button.dataset.cepmLayerKey === currentLayer;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
        }

        function buildLayerMenu() {
            var groupOrder = [
                'Températures',
                'Précipitations',
                'Vent',
                'Nuages et humidité',
                'Pression, instabilité et relief',
                'Autres'
            ];
            var grouped = {};
            layerGrid.replaceChildren();
            Object.keys(manifest.layers || {}).forEach(function (key) {
                var layer = manifest.layers[key];
                var group = layer.group || 'Autres';
                if (!grouped[group]) {
                    grouped[group] = [];
                }
                grouped[group].push({ key: key, layer: layer });
            });
            if (!manifest.layers[currentLayer]) {
                currentLayer = Object.keys(manifest.layers || {})[0] || '';
            }
            groupOrder.forEach(function (group) {
                if (!grouped[group] || !grouped[group].length) {
                    return;
                }
                var section = document.createElement('section');
                section.className = 'cepm-layer-group';
                var title = document.createElement('h3');
                title.textContent = group;
                section.appendChild(title);
                grouped[group].forEach(function (entry) {
                    var button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'cepm-layer-option';
                    button.dataset.cepmLayerKey = entry.key;
                    button.setAttribute('aria-pressed', 'false');
                    var label = document.createElement('span');
                    label.textContent = entry.layer.label || entry.key;
                    var dot = document.createElement('i');
                    dot.setAttribute('aria-hidden', 'true');
                    button.appendChild(label);
                    button.appendChild(dot);
                    button.addEventListener('click', function () {
                        setLayer(entry.key);
                        if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) {
                            setMenuOpen(false);
                        }
                    });
                    section.appendChild(button);
                });
                layerGrid.appendChild(section);
            });
            refreshLayerMenu();
        }

        function buildLegend() {
            legend.replaceChildren();
            var layer = manifest.layers[currentLayer];
            if (!layer || !Array.isArray(layer.stops) || !layer.stops.length) {
                return;
            }
            legend.classList.toggle('is-dense', layer.stops.length > 16);
            var strip = document.createElement('div');
            strip.className = 'cepm-legend-strip';
            layer.stops.forEach(function (stop) {
                var item = document.createElement('div');
                item.className = 'cepm-legend-stop';
                item.style.backgroundColor = stop.color;
                var label = document.createElement('span');
                label.textContent = stop.value;
                item.appendChild(label);
                strip.appendChild(item);
            });
            legend.appendChild(strip);
        }

        function preloadNeighbour(steps, index) {
            [-1, 1].forEach(function (offset) {
                var neighbour = steps[index + offset];
                if (!neighbour || !neighbour.files[currentLayer]) {
                    return;
                }
                var preload = new Image();
                preload.crossOrigin = 'anonymous';
                preload.src = versioned(neighbour.files[currentLayer]);
            });
        }

        function isPeriodLayer() {
            var layer = manifest && manifest.layers[currentLayer];
            return Boolean(layer && layer.range_mode);
        }

        function periodDateLabel(step) {
            return validityFormat.format(new Date(step.valid_time)).replace(':', 'h');
        }

        function updatePeriodControls() {
            var steps = availableSteps();
            if (!steps.length || !periodStartSlider || !periodEndSlider) {
                return;
            }
            periodStart = clamp(periodStart, 0, Math.max(0, steps.length - 2));
            periodEnd = clamp(periodEnd, periodStart + 1, steps.length - 1);
            periodStartSlider.max = String(steps.length - 1);
            periodEndSlider.max = String(steps.length - 1);
            periodStartSlider.value = String(periodStart);
            periodEndSlider.value = String(periodEnd);
            if (periodStartLabel) {
                periodStartLabel.textContent = periodDateLabel(steps[periodStart]);
            }
            if (periodEndLabel) {
                periodEndLabel.textContent = periodDateLabel(steps[periodEnd]);
            }
            var startLead = Number(steps[periodStart].lead_hour) || 0;
            var endLead = Number(steps[periodEnd].lead_hour) || 0;
            if (periodSummary) {
                periodSummary.textContent = 'H+' + startLead + ' → H+' + endLead +
                    ' • ' + Math.max(0, endLead - startLead) + ' h';
            }
            if (dualRange && dualRange.style && dualRange.style.setProperty) {
                var maximum = Math.max(1, steps.length - 1);
                dualRange.style.setProperty(
                    '--cepm-period-start', (periodStart / maximum * 100) + '%'
                );
                dualRange.style.setProperty(
                    '--cepm-period-end', (periodEnd / maximum * 100) + '%'
                );
            }
        }

        function configureTimeline() {
            var ranged = isPeriodLayer();
            if (singleTimeline) {
                singleTimeline.hidden = ranged;
            }
            if (timeline) {
                timeline.hidden = ranged;
            }
            if (periodSelector) {
                periodSelector.hidden = !ranged;
            }
            playButton.hidden = ranged || !animationEnabled || reducedMotion;
            if (!ranged) {
                return;
            }
            stopAnimation();
            var steps = availableSteps();
            if (steps.length < 2) {
                return;
            }
            if (periodEnd <= periodStart || periodEnd >= steps.length) {
                periodStart = 0;
                periodEnd = Math.min(8, steps.length - 1);
            }
            var layer = manifest.layers[currentLayer];
            if (periodTitle) {
                periodTitle.textContent = layer.range_mode === 'maximum'
                    ? 'Période des rafales maximales'
                    : 'Période du cumul de précipitations';
            }
            updatePeriodControls();
        }

        function schedulePeriodRender() {
            if (periodTimer !== null) {
                window.clearTimeout(periodTimer);
            }
            periodTimer = window.setTimeout(function () {
                periodTimer = null;
                renderPeriod();
            }, 180);
        }

        function mapLayerTitle(layer, step, sourceKey) {
            var title = (layer ? layer.label : 'Carte CEP') +
                (layer && layer.unit ? ' (' + layer.unit + ')' : '');
            var vectorKey = sourceKey || currentLayer;
            if (step && step.vectors &&
                    (step.vectors[currentLayer] || step.vectors[vectorKey])) {
                title += ' • isobares 4 hPa';
            }
            return title;
        }

        function renderPeriod() {
            var steps = availableSteps();
            var layer = manifest.layers[currentLayer];
            if (!layer || !layer.range_mode || steps.length < 2) {
                showError('Cette période ne peut pas encore être calculée.');
                return;
            }
            updatePeriodControls();
            currentStep = periodEnd;
            var startStep = steps[periodStart];
            var endStep = steps[periodEnd];
            var startDate = new Date(startStep.valid_time);
            var endDate = new Date(endStep.valid_time);
            var periodText = periodDateLabel(startStep) + ' au ' +
                periodDateLabel(endStep);
            validity.textContent = periodText;
            lead.textContent = 'H+' + startStep.lead_hour + ' → H+' + endStep.lead_hour;
            previousButton.disabled = periodEnd <= 1;
            nextButton.disabled = periodEnd >= steps.length - 1;
            viewport.setAttribute('aria-label', layer.label + ' — ' + periodText);
            var sourceKey = layer.source_key || currentLayer;
            mapTitle.textContent = mapLayerTitle(layer, endStep, sourceKey);
            mapDate.textContent = 'Du ' +
                mapDateFormat.format(startDate).replace(':', 'h') + ' au ' +
                mapDateFormat.format(endDate).replace(':', 'h');

            clearError();
            loading.textContent = 'Calcul de la période…';
            loading.hidden = false;
            currentWeatherImage = null;
            currentProbe = null;
            samplerReady = false;
            hideProbe();
            probeLoadToken += 1;
            var token = ++loadToken;
            var selectedSteps = layer.range_mode === 'difference'
                ? [startStep, endStep]
                : steps.slice(periodStart, periodEnd + 1);
            loadWeatherVectorOverlay(
                endStep.vectors && (endStep.vectors[currentLayer] ||
                    endStep.vectors[sourceKey])
                    ? (endStep.vectors[currentLayer] || endStep.vectors[sourceKey])
                    : null
            );
            fetchProbeSeries(selectedSteps, sourceKey, function (done, total) {
                if (token === loadToken) {
                    loading.textContent = 'Calcul de la période ' + done + '/' + total + '…';
                }
            }).then(function (grids) {
                if (token !== loadToken) {
                    return;
                }
                var combined = combinePeriodGrids(grids, layer.range_mode);
                var image = renderProbeGrid(combined, layer);
                currentProbe = combined;
                uploadWeatherImage(image);
                prepareImageSampler(image);
                loading.textContent = 'Chargement de la carte…';
                loading.hidden = true;
            }).catch(function (error) {
                if (token === loadToken) {
                    showError('Calcul de la période impossible : ' + error.message);
                }
            });
        }

        function renderStep(index) {
            var steps = availableSteps();
            if (!steps.length) {
                showError('Aucune carte disponible pour ce paramètre.');
                return;
            }
            if (isPeriodLayer()) {
                periodEnd = clamp(index, 1, steps.length - 1);
                if (periodStart >= periodEnd) {
                    periodStart = Math.max(0, periodEnd - 1);
                }
                updatePeriodControls();
                renderPeriod();
                return;
            }
            currentStep = clamp(index, 0, steps.length - 1);
            slider.max = String(steps.length - 1);
            slider.value = String(currentStep);
            previousButton.disabled = currentStep === 0;
            nextButton.disabled = currentStep === steps.length - 1;

            var step = steps[currentStep];
            var date = new Date(step.valid_time);
            validity.textContent = validityFormat.format(date).replace(':', 'h');
            lead.textContent = 'H+' + String(step.lead_hour).padStart(2, '0');
            var layer = manifest.layers[currentLayer];
            viewport.setAttribute(
                'aria-label',
                (layer ? layer.label : 'Carte météo') + ' — ' + validity.textContent
            );
            mapTitle.textContent = mapLayerTitle(layer, step, currentLayer);
            mapDate.textContent = mapDateFormat.format(date).replace(':', 'h') +
                ' (+' + step.lead_hour + 'h)';

            clearError();
            loading.textContent = 'Chargement de la carte…';
            loading.hidden = false;
            currentWeatherImage = null;
            samplerReady = false;
            hideProbe();
            var token = ++loadToken;
            var nextSource = versioned(step.files[currentLayer]);
            loadProbe(step);
            loadWeatherVectorOverlay(
                step.vectors && step.vectors[currentLayer]
                    ? step.vectors[currentLayer]
                    : null
            );
            var loader = new Image();
            loader.crossOrigin = 'anonymous';
            loader.onload = function () {
                if (token !== loadToken) {
                    return;
                }
                uploadWeatherImage(loader);
                prepareImageSampler(loader);
                loading.hidden = true;
                preloadNeighbour(steps, currentStep);
            };
            loader.onerror = function () {
                if (token === loadToken) {
                    showError('Cette carte n’est pas encore disponible. Réessayez dans quelques instants.');
                }
            };
            loader.src = nextSource;
        }

        function setLayer(layer) {
            if (!manifest.layers[layer]) {
                return;
            }
            if (periodTimer !== null) {
                window.clearTimeout(periodTimer);
                periodTimer = null;
            }
            currentLayer = layer;
            refreshLayerMenu();
            buildLegend();
            var steps = availableSteps();
            currentStep = clamp(currentStep, 0, Math.max(0, steps.length - 1));
            configureTimeline();
            if (isPeriodLayer()) {
                renderPeriod();
            } else {
                renderStep(currentStep);
            }
        }

        function stopAnimation() {
            if (timer !== null) {
                window.clearInterval(timer);
                timer = null;
            }
            playButton.textContent = '▶';
            playButton.setAttribute('aria-label', 'Lancer l’animation');
            playButton.title = 'Lancer l’animation';
            playButton.classList.remove('is-playing');
        }

        function toggleAnimation() {
            if (isPeriodLayer()) {
                return;
            }
            if (timer !== null) {
                stopAnimation();
                return;
            }
            var steps = availableSteps();
            if (steps.length < 2) {
                return;
            }
            playButton.textContent = '❚❚';
            playButton.setAttribute('aria-label', 'Arrêter l’animation');
            playButton.title = 'Arrêter l’animation';
            playButton.classList.add('is-playing');
            timer = window.setInterval(function () {
                var next = currentStep + 1;
                if (next >= availableSteps().length) {
                    next = 0;
                }
                renderStep(next);
            }, 1050);
        }

        function resizeCanvas(canvas, width, height, pixelRatio) {
            if (!canvas) {
                return false;
            }
            var canvasWidth = Math.max(1, Math.round(width * pixelRatio));
            var canvasHeight = Math.max(1, Math.round(height * pixelRatio));
            if (canvas.width === canvasWidth && canvas.height === canvasHeight) {
                return false;
            }
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            return true;
        }

        function compileShader(gl, type, source) {
            var shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        }

        function initialiseWebgl() {
            if (!weatherCanvas) {
                return null;
            }
            var gl = weatherCanvas.getContext('webgl', {
                alpha: false,
                antialias: false,
                depth: false,
                preserveDrawingBuffer: false
            });
            if (!gl) {
                return null;
            }
            var vertexShader = compileShader(gl, gl.VERTEX_SHADER,
                'attribute vec2 aPosition;\n' +
                'attribute vec2 aUv;\n' +
                'varying vec2 vUv;\n' +
                'void main(){vUv=aUv;gl_Position=vec4(aPosition,0.0,1.0);}'
            );
            var fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER,
                'precision mediump float;\n' +
                'varying vec2 vUv;\n' +
                'uniform sampler2D uWeather;\n' +
                'uniform float uScale;\n' +
                'uniform vec2 uTranslation;\n' +
                'uniform float uHasWeather;\n' +
                'void main(){\n' +
                ' vec3 base=vec3(0.6471,0.6510,0.6902);\n' +
                ' vec2 uv=(vUv-vec2(0.5)-uTranslation)/uScale+vec2(0.5);\n' +
                ' if(uHasWeather<0.5||uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0){\n' +
                '  gl_FragColor=vec4(base,1.0);return;\n' +
                ' }\n' +
                ' vec4 weather=texture2D(uWeather,uv);\n' +
                ' gl_FragColor=vec4(mix(base,weather.rgb,weather.a),1.0);\n' +
                '}'
            );
            if (!vertexShader || !fragmentShader) {
                return null;
            }
            var program = gl.createProgram();
            gl.attachShader(program, vertexShader);
            gl.attachShader(program, fragmentShader);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                return null;
            }
            gl.useProgram(program);
            var buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -1, 1, 0, 0,
                -1, -1, 0, 1,
                1, 1, 1, 0,
                1, -1, 1, 1
            ]), gl.STATIC_DRAW);
            var position = gl.getAttribLocation(program, 'aPosition');
            var uv = gl.getAttribLocation(program, 'aUv');
            gl.enableVertexAttribArray(position);
            gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
            gl.enableVertexAttribArray(uv);
            gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);

            var texture = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.uniform1i(gl.getUniformLocation(program, 'uWeather'), 0);

            return {
                gl: gl,
                program: program,
                texture: texture,
                scale: gl.getUniformLocation(program, 'uScale'),
                translation: gl.getUniformLocation(program, 'uTranslation'),
                hasWeather: gl.getUniformLocation(program, 'uHasWeather'),
                ready: false
            };
        }

        function uploadWeatherImage(source) {
            currentWeatherImage = source;
            if (!webgl) {
                scheduleRender();
                return;
            }
            var gl = webgl.gl;
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, webgl.texture);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                source
            );
            webgl.ready = true;
            scheduleRender();
        }

        function drawWeather(width, height, pixelRatio) {
            if (!weatherCanvas) {
                return;
            }
            resizeCanvas(weatherCanvas, width, height, pixelRatio);
            if (webgl) {
                var gl = webgl.gl;
                gl.viewport(0, 0, weatherCanvas.width, weatherCanvas.height);
                gl.useProgram(webgl.program);
                gl.uniform1f(webgl.scale, transform.scale);
                gl.uniform2f(
                    webgl.translation,
                    transform.x / width,
                    transform.y / height
                );
                gl.uniform1f(webgl.hasWeather, webgl.ready ? 1 : 0);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                return;
            }
            if (!fallbackContext) {
                fallbackContext = weatherCanvas.getContext('2d');
            }
            if (!fallbackContext) {
                return;
            }
            fallbackContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            fallbackContext.fillStyle = '#a5a6b0';
            fallbackContext.fillRect(0, 0, width, height);
            if (!currentWeatherImage) {
                return;
            }
            fallbackContext.save();
            fallbackContext.translate(
                width / 2 + transform.x,
                height / 2 + transform.y
            );
            fallbackContext.scale(transform.scale, transform.scale);
            fallbackContext.translate(-width / 2, -height / 2);
            fallbackContext.imageSmoothingEnabled = true;
            fallbackContext.imageSmoothingQuality = 'high';
            fallbackContext.drawImage(currentWeatherImage, 0, 0, width, height);
            fallbackContext.restore();
        }

        function parseVectorOverlay(source) {
                var documentSvg = new DOMParser().parseFromString(
                    source,
                    'image/svg+xml'
                );
                var svg = documentSvg.documentElement;
                var viewBox = String(svg.getAttribute('viewBox') || '')
                    .trim().split(/\s+/).map(Number);
                if (viewBox.length !== 4 || !viewBox[2] || !viewBox[3]) {
                    throw new Error('surcouche vectorielle invalide');
                }
                var paths = Array.from(svg.querySelectorAll('path')).map(
                    function (node) {
                        var role = node.getAttribute('data-cepm-role') || '';
                        var arrowPoints = [];
                        var isobarLabels = [];
                        if (role === 'wind-arrows') {
                            arrowPoints = String(
                                node.getAttribute('data-cepm-points') || ''
                            ).split(';').map(function (point) {
                                var values = point.split(',').map(Number);
                                if (values.length !== 5 || values.some(function (value) {
                                    return !Number.isFinite(value);
                                })) {
                                    return null;
                                }
                                return {
                                    x: values[0],
                                    y: values[1],
                                    dx: values[2],
                                    dy: values[3],
                                    speed: values[4]
                                };
                            }).filter(Boolean);
                        }
                        if (role === 'isobar-labels') {
                            isobarLabels = String(
                                node.getAttribute('data-cepm-labels') || ''
                            ).split(';').map(function (label) {
                                var values = label.split(',').map(Number);
                                if (values.length !== 3 || values.some(function (value) {
                                    return !Number.isFinite(value);
                                })) {
                                    return null;
                                }
                                return { x: values[0], y: values[1], value: values[2] };
                            }).filter(Boolean);
                        }
                        return {
                            path: new Path2D(node.getAttribute('d') || ''),
                            colour: node.getAttribute('stroke') || '#101116',
                            opacity: Number(node.getAttribute('stroke-opacity') || 1),
                            width: Number(node.getAttribute('stroke-width') || 1),
                            lineCap: node.getAttribute('stroke-linecap') || 'butt',
                            lineJoin: node.getAttribute('stroke-linejoin') || 'miter',
                            hideAtDeepZoom:
                                node.getAttribute('data-cepm-hide-deep') === '1',
                            role: role,
                            arrowPoints: arrowPoints,
                            isobarLabels: isobarLabels
                        };
                    }
                );
                return {
                    width: viewBox[2],
                    height: viewBox[3],
                    paths: paths,
                    windArrows: paths.reduce(function (all, entry) {
                        return all.concat(entry.arrowPoints);
                    }, []),
                    isobarLabels: paths.reduce(function (all, entry) {
                        return all.concat(entry.isobarLabels);
                    }, [])
                };
        }

        function loadVectorOverlay(path) {
            if (!path || !vectorContext || typeof window.Path2D !== 'function') {
                return Promise.resolve();
            }
            return fetchText(versioned(path)).then(function (source) {
                baseVectorDefinition = parseVectorOverlay(source);
                scheduleRender();
            }).catch(function () {
                baseVectorDefinition = null;
            });
        }

        function loadWeatherVectorOverlay(path) {
            var token = ++vectorLoadToken;
            weatherVectorDefinition = null;
            scheduleRender();
            if (!path || !vectorContext || typeof window.Path2D !== 'function') {
                return Promise.resolve();
            }
            return fetchText(versioned(path)).then(function (source) {
                if (token !== vectorLoadToken) { return; }
                weatherVectorDefinition = parseVectorOverlay(source);
                scheduleRender();
            }).catch(function () {
                if (token === vectorLoadToken) {
                    weatherVectorDefinition = null;
                    scheduleRender();
                }
            });
        }

        function drawScreenWindArrows(
            arrows,
            horizontalScale,
            verticalScale,
            offsetX,
            offsetY,
            width,
            height,
            pixelRatio
        ) {
            if (!arrows.length) { return; }
            vectorContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            var arrowHeads = [];
            vectorContext.beginPath();
            arrows.forEach(function (arrow) {
                var centreX = offsetX + arrow.x * horizontalScale;
                var centreY = offsetY + arrow.y * verticalScale;
                if (centreX < -35 || centreX > width + 35 ||
                        centreY < -35 || centreY > height + 35) {
                    return;
                }
                var screenDx = arrow.dx * horizontalScale;
                var screenDy = arrow.dy * verticalScale;
                var magnitude = Math.hypot(screenDx, screenDy);
                if (!magnitude) { return; }
                screenDx /= magnitude;
                screenDy /= magnitude;
                var length = clamp(17 + arrow.speed * 0.08, 18, 25);
                var head = clamp(length * 0.29, 5.2, 6.8);
                var normalX = -screenDy;
                var normalY = screenDx;
                var startX = centreX - screenDx * length / 2;
                var startY = centreY - screenDy * length / 2;
                var endX = centreX + screenDx * length / 2;
                var endY = centreY + screenDy * length / 2;
                var shaftX = endX - screenDx * head * 0.52;
                var shaftY = endY - screenDy * head * 0.52;
                var leftX = endX - screenDx * head + normalX * head * 0.48;
                var leftY = endY - screenDy * head + normalY * head * 0.48;
                var rightX = endX - screenDx * head - normalX * head * 0.48;
                var rightY = endY - screenDy * head - normalY * head * 0.48;
                vectorContext.moveTo(startX, startY);
                vectorContext.lineTo(shaftX, shaftY);
                arrowHeads.push({
                    tipX: endX,
                    tipY: endY,
                    leftX: leftX,
                    leftY: leftY,
                    rightX: rightX,
                    rightY: rightY
                });
            });
            vectorContext.lineCap = 'round';
            vectorContext.lineJoin = 'round';
            vectorContext.globalAlpha = 0.98;
            vectorContext.strokeStyle = '#f7fbfd';
            vectorContext.lineWidth = 4.8;
            vectorContext.stroke();
            vectorContext.globalAlpha = 0.99;
            vectorContext.strokeStyle = '#061b28';
            vectorContext.lineWidth = 1.6;
            vectorContext.stroke();

            vectorContext.beginPath();
            arrowHeads.forEach(function (head) {
                vectorContext.moveTo(head.tipX, head.tipY);
                vectorContext.lineTo(head.leftX, head.leftY);
                vectorContext.lineTo(head.rightX, head.rightY);
                vectorContext.closePath();
            });
            vectorContext.globalAlpha = 0.98;
            vectorContext.strokeStyle = '#f7fbfd';
            vectorContext.lineWidth = 3.6;
            vectorContext.stroke();
            vectorContext.fillStyle = '#061b28';
            vectorContext.fill();
            vectorContext.strokeStyle = '#061b28';
            vectorContext.lineWidth = 0.9;
            vectorContext.stroke();
        }

        function drawScreenIsobarLabels(
            labels,
            horizontalScale,
            verticalScale,
            offsetX,
            offsetY,
            width,
            height,
            pixelRatio
        ) {
            if (!labels.length) { return; }
            vectorContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            vectorContext.font = '700 11px Inter, "Segoe UI", Arial, sans-serif';
            vectorContext.textAlign = 'center';
            vectorContext.textBaseline = 'middle';
            vectorContext.lineJoin = 'round';
            labels.forEach(function (label) {
                var x = offsetX + label.x * horizontalScale;
                var y = offsetY + label.y * verticalScale;
                if (x < 24 || x > width - 24 || y < 18 || y > height - 18) {
                    return;
                }
                var text = String(Math.round(label.value));
                vectorContext.globalAlpha = 0.94;
                vectorContext.strokeStyle = '#f5fafc';
                vectorContext.lineWidth = 4.5;
                vectorContext.strokeText(text, x, y);
                vectorContext.globalAlpha = 0.9;
                vectorContext.fillStyle = '#132934';
                vectorContext.fillText(text, x, y);
            });
        }

        function drawVectors(width, height, pixelRatio) {
            if (!vectorContext) {
                return;
            }
            resizeCanvas(vectorCanvas, width, height, pixelRatio);
            vectorContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            vectorContext.clearRect(0, 0, width, height);
            var screenArrowLayers = [];
            var screenIsobarLayers = [];
            [weatherVectorDefinition, baseVectorDefinition].forEach(function (definition) {
                if (!definition) { return; }
                var horizontalScale = transform.scale * width / definition.width;
                var verticalScale = transform.scale * height / definition.height;
                var offsetX = width / 2 + transform.x - transform.scale * width / 2;
                var offsetY = height / 2 + transform.y - transform.scale * height / 2;
                vectorContext.setTransform(
                    pixelRatio * horizontalScale,
                    0,
                    0,
                    pixelRatio * verticalScale,
                    pixelRatio * offsetX,
                    pixelRatio * offsetY
                );
                definition.paths.forEach(function (entry) {
                    if (entry.hideAtDeepZoom && transform.scale > 3.2) {
                        return;
                    }
                    if (entry.role === 'wind-arrows' ||
                            entry.role === 'isobar-labels' ||
                            (definition.windArrows.length &&
                            entry.role === 'wind-arrow-fallback')) {
                        return;
                    }
                    vectorContext.strokeStyle = entry.colour;
                    vectorContext.globalAlpha = entry.opacity;
                    vectorContext.lineCap = entry.lineCap;
                    vectorContext.lineJoin = entry.lineJoin;
                    vectorContext.lineWidth = entry.width / horizontalScale;
                    vectorContext.stroke(entry.path);
                });
                if (definition.windArrows.length) {
                    screenArrowLayers.push({
                        arrows: definition.windArrows,
                        horizontalScale: horizontalScale,
                        verticalScale: verticalScale,
                        offsetX: offsetX,
                        offsetY: offsetY
                    });
                }
                if (definition.isobarLabels.length) {
                    screenIsobarLayers.push({
                        labels: definition.isobarLabels,
                        horizontalScale: horizontalScale,
                        verticalScale: verticalScale,
                        offsetX: offsetX,
                        offsetY: offsetY
                    });
                }
            });
            screenArrowLayers.forEach(function (layer) {
                drawScreenWindArrows(
                    layer.arrows,
                    layer.horizontalScale,
                    layer.verticalScale,
                    layer.offsetX,
                    layer.offsetY,
                    width,
                    height,
                    pixelRatio
                );
            });
            screenIsobarLayers.forEach(function (layer) {
                drawScreenIsobarLabels(
                    layer.labels,
                    layer.horizontalScale,
                    layer.verticalScale,
                    layer.offsetX,
                    layer.offsetY,
                    width,
                    height,
                    pixelRatio
                );
            });
            vectorContext.globalAlpha = 1;
        }

        function scheduleRender() {
            if (renderFrame !== null) {
                return;
            }
            renderFrame = window.requestAnimationFrame(function () {
                renderFrame = null;
                var width = viewport.clientWidth;
                var height = viewport.clientHeight;
                if (!width || !height) {
                    return;
                }
                var pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
                drawWeather(width, height, pixelRatio);
                drawVectors(width, height, pixelRatio);
                drawLabels(width, height, pixelRatio);
            });
        }

        function mercator(latitude) {
            var radians = clamp(latitude, -85, 85) * Math.PI / 180;
            return Math.log(Math.tan(Math.PI / 4 + radians / 2));
        }

        function inverseMercator(value) {
            return (2 * Math.atan(Math.exp(value)) - Math.PI / 2) * 180 / Math.PI;
        }

        function visiblePlaces(width, height, bounds, northY, mercatorSpan, density) {
            if (transform.scale < 1.35 || !placeBuckets.size) {
                return places;
            }
            var mapLeft = (0 - width / 2 - transform.x) / transform.scale + width / 2;
            var mapRight = (width - width / 2 - transform.x) /
                transform.scale + width / 2;
            var mapTop = (0 - height / 2 - transform.y) / transform.scale + height / 2;
            var mapBottom = (height - height / 2 - transform.y) /
                transform.scale + height / 2;
            var longitudeSpan = Number(bounds.east) - Number(bounds.west);
            var west = Number(bounds.west) + mapLeft / width * longitudeSpan;
            var east = Number(bounds.west) + mapRight / width * longitudeSpan;
            var north = inverseMercator(northY - mapTop / height * mercatorSpan);
            var south = inverseMercator(northY - mapBottom / height * mercatorSpan);
            var candidates = [];
            for (var latitude = Math.floor(south) - 1;
                    latitude <= Math.ceil(north) + 1; latitude += 1) {
                for (var longitude = Math.floor(west) - 1;
                        longitude <= Math.ceil(east) + 1; longitude += 1) {
                    var bucket = placeBuckets.get(latitude + '|' + longitude) || [];
                    for (var index = 0; index < bucket.length; index += 1) {
                        if (Number(bucket[index][1]) < density.population) {
                            break;
                        }
                        candidates.push(bucket[index]);
                    }
                }
            }
            candidates.sort(function (first, second) {
                return Number(second[1]) - Number(first[1]);
            });
            return candidates;
        }

        function labelDensity() {
            if (transform.scale < 1.35) {
                return { population: 250000, maximum: 18, size: 10 };
            }
            if (transform.scale < 2.25) {
                return { population: 80000, maximum: 34, size: 10 };
            }
            if (transform.scale < 3.75) {
                return { population: 18000, maximum: 68, size: 11 };
            }
            if (transform.scale < 6) {
                return { population: 4000, maximum: 115, size: 11 };
            }
            if (transform.scale < 8) {
                return { population: 900, maximum: 170, size: 11 };
            }
            if (transform.scale < 16) {
                return { population: 150, maximum: 240, size: 12 };
            }
            if (transform.scale < 32) {
                return { population: 30, maximum: 210, size: 12 };
            }
            return { population: 1, maximum: 180, size: 12 };
        }

        function overlaps(rectangle, occupied) {
            for (var index = 0; index < occupied.length; index += 1) {
                var other = occupied[index];
                if (rectangle.left < other.right && rectangle.right > other.left &&
                        rectangle.top < other.bottom && rectangle.bottom > other.top) {
                    return true;
                }
            }
            return false;
        }

        function drawLabels(width, height, pixelRatio) {
            if (!labelsContext || !manifest) {
                return;
            }
            resizeCanvas(labelsCanvas, width, height, pixelRatio);
            labelsContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            labelsContext.clearRect(0, 0, width, height);
            if (!places.length || !manifest.bounds) {
                return;
            }

            var bounds = manifest.bounds;
            var northY = mercator(Number(bounds.north));
            var southY = mercator(Number(bounds.south));
            var longitudeSpan = Number(bounds.east) - Number(bounds.west);
            var mercatorSpan = northY - southY;
            if (!longitudeSpan || !mercatorSpan) {
                return;
            }

            var density = labelDensity();
            var candidates = visiblePlaces(
                width,
                height,
                bounds,
                northY,
                mercatorSpan,
                density
            );
            var occupied = [];
            var drawn = 0;
            labelsContext.font = '700 ' + density.size + 'px Arial, sans-serif';
            labelsContext.textAlign = 'center';
            labelsContext.textBaseline = 'middle';
            labelsContext.lineJoin = 'round';
            labelsContext.strokeStyle = 'rgba(8, 19, 28, .94)';
            labelsContext.fillStyle = '#ffffff';
            labelsContext.lineWidth = density.size >= 12 ? 3.5 : 3;

            for (var index = 0; index < candidates.length; index += 1) {
                var place = candidates[index];
                if (!Array.isArray(place) || place.length < 4) {
                    continue;
                }
                if (Number(place[1]) < density.population) {
                    break;
                }
                var mapX = (Number(place[3]) - Number(bounds.west)) /
                    longitudeSpan * width;
                var mapY = (northY - mercator(Number(place[2]))) /
                    mercatorSpan * height;
                var screenX = (mapX - width / 2) * transform.scale +
                    width / 2 + transform.x;
                var screenY = (mapY - height / 2) * transform.scale +
                    height / 2 + transform.y;
                if (screenX < -80 || screenX > width + 80 ||
                        screenY < -15 || screenY > height + 15) {
                    continue;
                }
                var text = String(place[0]);
                var textWidth = labelsContext.measureText(text).width;
                var rectangle = {
                    left: screenX - textWidth / 2 - 4,
                    right: screenX + textWidth / 2 + 4,
                    top: screenY - density.size / 2 - 3,
                    bottom: screenY + density.size / 2 + 3
                };
                if (overlaps(rectangle, occupied)) {
                    continue;
                }
                occupied.push(rectangle);
                labelsContext.strokeText(text, screenX, screenY);
                labelsContext.fillText(text, screenX, screenY);
                drawn += 1;
                if (drawn >= density.maximum) {
                    break;
                }
            }
        }

        function loadPlaces() {
            if (!manifest || !manifest.places) {
                return Promise.resolve();
            }
            return fetchJson(versioned(manifest.places))
                .then(function (payload) {
                    places = payload && Array.isArray(payload.places) ?
                        payload.places : [];
                    placeBuckets = new Map();
                    places.forEach(function (place) {
                        if (!Array.isArray(place) || place.length < 4) {
                            return;
                        }
                        var key = Math.floor(Number(place[2])) + '|' +
                            Math.floor(Number(place[3]));
                        if (!placeBuckets.has(key)) {
                            placeBuckets.set(key, []);
                        }
                        placeBuckets.get(key).push(place);
                    });
                    scheduleRender();
                })
                .catch(function () {
                    places = [];
                    placeBuckets = new Map();
                });
        }

        function applyTransform() {
            var maxX = viewport.clientWidth * (transform.scale - 1) / 2;
            var maxY = viewport.clientHeight * (transform.scale - 1) / 2;
            transform.x = clamp(transform.x, -maxX, maxX);
            transform.y = clamp(transform.y, -maxY, maxY);
            zoomLevel.textContent = Math.round(transform.scale * 100) + ' %';
            zoomOut.disabled = transform.scale <= 1.001;
            zoomIn.disabled = transform.scale >= maxScale - 0.001;
            viewport.classList.toggle('is-zoomed', transform.scale > 1.001);
            scheduleRender();
            if (lastHover) {
                updateProbe(lastHover.x, lastHover.y);
            }
            positionPinned();
        }

        function changeZoom(nextScale, clientX, clientY) {
            var previousScale = transform.scale;
            nextScale = clamp(nextScale, 1, maxScale);
            var box = viewport.getBoundingClientRect();
            var px = (typeof clientX === 'number' ? clientX : box.left + box.width / 2) -
                box.left - box.width / 2;
            var py = (typeof clientY === 'number' ? clientY : box.top + box.height / 2) -
                box.top - box.height / 2;
            var worldX = (px - transform.x) / previousScale;
            var worldY = (py - transform.y) / previousScale;
            transform.x = px - worldX * nextScale;
            transform.y = py - worldY * nextScale;
            transform.scale = nextScale;
            applyTransform();
        }

        function resetView() {
            transform = { scale: 1, x: 0, y: 0 };
            applyTransform();
        }

        function focusLocation(detail) {
            pendingFocus = detail || null;
            if (!manifest || !pendingFocus || !manifest.bounds) {
                return;
            }
            var width = viewport.clientWidth;
            var height = viewport.clientHeight;
            var latitude = Number(pendingFocus.latitude);
            var longitude = Number(pendingFocus.longitude);
            if (!width || !height || !Number.isFinite(latitude) ||
                    !Number.isFinite(longitude)) {
                return;
            }
            var bounds = manifest.bounds;
            var west = Number(bounds.west);
            var east = Number(bounds.east);
            var northY = mercator(Number(bounds.north));
            var southY = mercator(Number(bounds.south));
            var u = (longitude - west) / (east - west);
            var v = (northY - mercator(latitude)) / (northY - southY);
            var scale = clamp(Number(pendingFocus.scale) || 6, 1, maxScale);
            transform.scale = scale;
            transform.x = width * scale * (0.5 - u);
            transform.y = height * scale * (0.5 - v);
            pendingFocus = null;
            applyTransform();
        }

        app.addEventListener('cepm:focus-location', function (event) {
            focusedLocation = event.detail || null;
            focusLocation(event.detail);
        });

        menuToggle.addEventListener('click', function () {
            setMenuOpen(layerMenu.hidden);
        });
        menuClose.addEventListener('click', function () {
            var opening = layerMenu.hidden;
            setMenuOpen(opening);
            if (!opening) {
                menuToggle.focus();
            }
        });
        app.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && !layerMenu.hidden) {
                setMenuOpen(false);
                menuToggle.focus();
            }
        });
        previousButton.addEventListener('click', function () {
            stopAnimation();
            renderStep(currentStep - 1);
        });
        nextButton.addEventListener('click', function () {
            stopAnimation();
            renderStep(currentStep + 1);
        });
        playButton.addEventListener('click', toggleAnimation);
        slider.addEventListener('input', function () {
            stopAnimation();
            renderStep(Number(slider.value));
        });
        if (periodStartSlider) {
            periodStartSlider.addEventListener('input', function () {
                stopAnimation();
                periodStart = Math.min(
                    Number(periodStartSlider.value), periodEnd - 1
                );
                updatePeriodControls();
                schedulePeriodRender();
            });
        }
        if (periodEndSlider) {
            periodEndSlider.addEventListener('input', function () {
                stopAnimation();
                periodEnd = Math.max(
                    Number(periodEndSlider.value), periodStart + 1
                );
                updatePeriodControls();
                schedulePeriodRender();
            });
        }
        zoomIn.addEventListener('click', function () {
            changeZoom(transform.scale * 1.5);
        });
        zoomOut.addEventListener('click', function () {
            changeZoom(transform.scale / 1.5);
        });
        reset.addEventListener('click', resetView);
        fullscreen.addEventListener('click', function () {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else if (app.requestFullscreen) {
                app.requestFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', function () {
            window.setTimeout(applyTransform, 50);
        });
        toolButtons.forEach(function (button) {
            button.addEventListener('click', function () {
                setToolMode(button.dataset.cepmTool);
            });
        });
        if (captureButton) {
            captureButton.addEventListener('click', captureImage);
        }
        if (copyButton) {
            copyButton.addEventListener('click', copyImage);
        }
        if (diagramClose) {
            diagramClose.addEventListener('click', closeDiagram);
        }
        viewport.addEventListener('wheel', function (event) {
            event.preventDefault();
            changeZoom(
                transform.scale * Math.pow(1.0015, -event.deltaY),
                event.clientX,
                event.clientY
            );
        }, { passive: false });
        viewport.addEventListener('dblclick', function (event) {
            changeZoom(transform.scale * 1.65, event.clientX, event.clientY);
        });

        function pointerPair() {
            return Array.from(activePointers.values()).slice(0, 2);
        }

        function startGesture() {
            var points = pointerPair();
            if (!points.length) {
                gesture = null;
                return;
            }
            if (points.length === 1) {
                gesture = {
                    type: 'drag',
                    x: points[0].x,
                    y: points[0].y,
                    startX: transform.x,
                    startY: transform.y
                };
                return;
            }
            var centerX = (points[0].x + points[1].x) / 2;
            var centerY = (points[0].y + points[1].y) / 2;
            var distance = Math.hypot(
                points[1].x - points[0].x,
                points[1].y - points[0].y
            );
            var box = viewport.getBoundingClientRect();
            var px = centerX - box.left - box.width / 2;
            var py = centerY - box.top - box.height / 2;
            gesture = {
                type: 'pinch',
                distance: Math.max(distance, 1),
                scale: transform.scale,
                worldX: (px - transform.x) / transform.scale,
                worldY: (py - transform.y) / transform.scale
            };
        }

        viewport.addEventListener('pointermove', function (event) {
            if (event.pointerType && event.pointerType !== 'mouse') {
                return;
            }
            if (activePointers.size) {
                hideProbe();
                return;
            }
            var clientX = event.clientX;
            var clientY = event.clientY;
            lastHover = { x: clientX, y: clientY };
            if (hoverFrame !== null) {
                return;
            }
            hoverFrame = window.requestAnimationFrame(function () {
                hoverFrame = null;
                if (lastHover) {
                    updateProbe(lastHover.x, lastHover.y);
                }
            });
        });
        viewport.addEventListener('pointerleave', hideProbe);

        viewport.addEventListener('pointerdown', function (event) {
            if (event.target.closest('button, .cepm-diagram-popup, .cepm-probe-pinned')) {
                return;
            }
            hideProbe();
            tapStart = {
                x: event.clientX,
                y: event.clientY,
                time: Date.now(),
                pointerId: event.pointerId
            };
            activePointers.set(event.pointerId, {
                x: event.clientX,
                y: event.clientY
            });
            viewport.setPointerCapture(event.pointerId);
            startGesture();
            viewport.classList.add('is-dragging');
        });
        viewport.addEventListener('pointermove', function (event) {
            if (!activePointers.has(event.pointerId)) {
                return;
            }
            activePointers.set(event.pointerId, {
                x: event.clientX,
                y: event.clientY
            });
            var points = pointerPair();
            if (points.length >= 2) {
                if (!gesture || gesture.type !== 'pinch') {
                    startGesture();
                    return;
                }
                var centerX = (points[0].x + points[1].x) / 2;
                var centerY = (points[0].y + points[1].y) / 2;
                var distance = Math.hypot(
                    points[1].x - points[0].x,
                    points[1].y - points[0].y
                );
                var box = viewport.getBoundingClientRect();
                var px = centerX - box.left - box.width / 2;
                var py = centerY - box.top - box.height / 2;
                transform.scale = clamp(
                    gesture.scale * distance / gesture.distance,
                    1,
                    maxScale
                );
                transform.x = px - gesture.worldX * transform.scale;
                transform.y = py - gesture.worldY * transform.scale;
            } else if (gesture && gesture.type === 'drag') {
                transform.x = gesture.startX + points[0].x - gesture.x;
                transform.y = gesture.startY + points[0].y - gesture.y;
            }
            applyTransform();
        });
        function endPointer(event) {
            var wasMultiTouch = activePointers.size > 1;
            if (activePointers.has(event.pointerId)) {
                activePointers.delete(event.pointerId);
                if (activePointers.size) {
                    startGesture();
                } else {
                    gesture = null;
                }
            }
            if (!activePointers.size) {
                viewport.classList.remove('is-dragging');
            }
            if (tapStart && tapStart.pointerId === event.pointerId) {
                var dx = event.clientX - tapStart.x;
                var dy = event.clientY - tapStart.y;
                var dt = Date.now() - tapStart.time;
                tapStart = null;
                if (!wasMultiTouch && Math.hypot(dx, dy) < 6 && dt < 600) {
                    if (toolMode === 'diagram') {
                        openDiagramAt(event.clientX, event.clientY);
                    } else if (pinnedEnabled) {
                        pinProbeAt(event.clientX, event.clientY);
                    }
                }
            }
        }
        viewport.addEventListener('pointerup', endPointer);
        viewport.addEventListener('pointercancel', endPointer);
        window.addEventListener('resize', applyTransform);

        if (!animationEnabled || reducedMotion) {
            playButton.hidden = true;
        }
        if (!baseUrl) {
            showError('Adresse des données CEP non configurée.');
            return;
        }
        webgl = initialiseWebgl();

        fetchJson(
            baseUrl + '/maps/index.json?module=' +
            encodeURIComponent(moduleVersion) + '&minute=' +
            Math.floor(Date.now() / 60000)
        )
            .then(function (payload) {
                if (!payload || payload.status !== 'ok' ||
                        !payload.layers || !Array.isArray(payload.steps)) {
                    throw new Error('manifeste cartographique invalide');
                }
                manifest = payload;
                buildLayerMenu();
                buildLegend();
                configureTimeline();
                loadVectorOverlay(payload.overlay);
                loadPlaces();

                if (payload.run_time) {
                    run.textContent = 'Run du ' +
                        runFormat.format(new Date(payload.run_time)).replace(':', 'h') +
                        ' • résolution 0,25° (~28 km)';
                    mapRun.textContent = 'Run CEP ' +
                        runLabelUtc(payload.run_time);
                }
                if (payload.generated_at) {
                    generated.textContent = 'Cartes mises à jour le ' +
                        runFormat.format(new Date(payload.generated_at)).replace(':', 'h') +
                        ' • Module v' + moduleVersion;
                    stale.hidden = (Date.now() - new Date(payload.generated_at).getTime()) <=
                        8 * 60 * 60 * 1000;
                }
                var steps = availableSteps();
                currentStep = initialStep(steps);
                setMenuOpen(!window.matchMedia ||
                    !window.matchMedia('(max-width: 760px)').matches);
                applyTransform();
                renderStep(currentStep);
                focusLocation(pendingFocus);
            })
            .catch(function (error) {
                showError('Les cartes CEP ne sont pas encore publiées : ' + error.message);
            });
    }

    whenReady(function () {
        document.querySelectorAll('[data-cepm-app]').forEach(initMap);
    });
}());
