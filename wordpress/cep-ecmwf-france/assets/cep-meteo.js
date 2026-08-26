(function () {
    'use strict';

    var COMMUNES_API = 'https://geo.api.gouv.fr/communes';
    var DIRECTIONS = [
        'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
        'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'
    ];
    var CONDITIONS = {
        0: { label: 'Indéterminé', icon: '•' },
        1: { label: 'Dégagé', icon: '☀️' },
        2: { label: 'Peu nuageux', icon: '🌤️' },
        3: { label: 'Nuageux', icon: '⛅' },
        4: { label: 'Couvert', icon: '☁️' },
        5: { label: 'Pluie', icon: '🌦️' },
        6: { label: 'Forte pluie', icon: '🌧️' },
        7: { label: 'Neige', icon: '❄️' },
        8: { label: 'Brouillard', icon: '🌫️' },
        9: { label: 'Très venteux', icon: '💨' }
    };

    var THUNDER_RISKS = {
        0: { label: 'Nul', icon: '⚪' },
        1: { label: 'Faible', icon: '🟢' },
        2: { label: 'Modéré', icon: '🟡' },
        3: { label: 'Fort', icon: '🟠' },
        4: { label: 'Sévère', icon: '🔴' }
    };
    var HAZARD_RISKS = {
        0: 'Nul',
        1: 'Faible',
        2: 'Modéré',
        3: 'Fort'
    };
    var STORM_TYPES = {
        0: 'Pas de convection active',
        1: 'Convection faible / isolée',
        2: 'Convection probable',
        3: 'Orage fort possible',
        4: 'Convection sévère possible'
    };
    var SNOW_RISKS = {
        0: { label: 'Aucun', icon: '⚪' },
        1: { label: 'Faible', icon: '🟢' },
        2: { label: 'Modéré', icon: '🟡' },
        3: { label: 'Fort', icon: '🟠' },
        4: { label: 'Très fort', icon: '🔴' }
    };
    var SNOW_STICK = { 0: 'Aucune', 1: 'Faible', 2: 'Possible', 3: 'Probable' };
    var SNOW_PHASE = { 0: '—', 1: 'Pluie', 2: 'Pluie/neige', 3: 'Neige' };
    var LEGACY_COLUMNS = [
        'temperature_c', 'humidity_pct', 'precipitation_mm', 'cloud_cover_pct',
        'wind_speed_kmh', 'wind_direction_deg', 'wind_gust_kmh', 'pressure_hpa',
        'visibility_km', 'condition_code'
    ];


    function whenReady(callback) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback);
        } else {
            callback();
        }
    }

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    function formatNumber(value, decimals) {
        if (!finite(value)) {
            return '—';
        }
        return value.toLocaleString('fr-FR', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    function roundUpFive(value) {
        if (!finite(value)) {
            return null;
        }
        return Math.ceil(Math.max(0, Number(value)) / 5) * 5;
    }

    function dateFormatter(timezone, options) {
        try {
            return new Intl.DateTimeFormat('fr-FR', Object.assign(
                { timeZone: timezone },
                options
            ));
        } catch (error) {
            return new Intl.DateTimeFormat('fr-FR', options);
        }
    }

    function windDirection(degrees) {
        if (!finite(degrees)) {
            return '';
        }
        return DIRECTIONS[Math.round(degrees / 22.5) % 16];
    }

    function temperatureClass(value) {
        if (!finite(value)) { return ''; }
        if (value >= 35) { return 'cep-temp-extreme'; }
        if (value >= 30) { return 'cep-temp-hot'; }
        if (value >= 22) { return 'cep-temp-warm'; }
        if (value >= 12) { return 'cep-temp-mild'; }
        if (value >= 4) { return 'cep-temp-cool'; }
        return 'cep-temp-cold';
    }

    function gustClass(value) {
        if (!finite(value)) { return ''; }
        if (value >= 80) { return 'cep-gust-danger'; }
        if (value >= 60) { return 'cep-gust-strong'; }
        if (value >= 40) { return 'cep-gust-moderate'; }
        return '';
    }

    function windForceClass(value) {
        if (!finite(value)) { return 'cep-wind-calm'; }
        if (value >= 80) { return 'cep-wind-violent'; }
        if (value >= 60) { return 'cep-wind-strong'; }
        if (value >= 40) { return 'cep-wind-fresh'; }
        if (value >= 20) { return 'cep-wind-moderate'; }
        return 'cep-wind-light';
    }

    function rainClass(value) {
        if (!finite(value) || value < 0.1) { return ''; }
        if (value >= 15) { return 'cep-rain cep-rain-intense'; }
        if (value >= 5) { return 'cep-rain cep-rain-strong'; }
        if (value >= 2) { return 'cep-rain cep-rain-moderate'; }
        if (value >= 0.5) { return 'cep-rain cep-rain-light'; }
        return 'cep-rain cep-rain-trace';
    }

    function svgElement(name, attributes, text) {
        var node = document.createElementNS('http://www.w3.org/2000/svg', name);
        Object.keys(attributes || {}).forEach(function (key) {
            node.setAttribute(key, String(attributes[key]));
        });
        if (typeof text === 'string') {
            node.textContent = text;
        }
        return node;
    }

    function finiteValues(values) {
        return values.filter(function (value) { return finite(value); });
    }

    function niceNumber(value, roundValue) {
        if (!finite(value) || value <= 0) { return 1; }
        var exponent = Math.floor(Math.log10(value));
        var fraction = value / Math.pow(10, exponent);
        var niceFraction;
        if (roundValue) {
            if (fraction < 1.5) { niceFraction = 1; }
            else if (fraction < 3) { niceFraction = 2; }
            else if (fraction < 7) { niceFraction = 5; }
            else { niceFraction = 10; }
        } else {
            if (fraction <= 1) { niceFraction = 1; }
            else if (fraction <= 2) { niceFraction = 2; }
            else if (fraction <= 5) { niceFraction = 5; }
            else { niceFraction = 10; }
        }
        return niceFraction * Math.pow(10, exponent);
    }

    function chartScale(values, forceZero, targetTicks, paddingSteps) {
        var clean = finiteValues(values);
        if (!clean.length) { return null; }
        var minimum = Math.min.apply(null, clean);
        var maximum = Math.max.apply(null, clean);
        if (forceZero) { minimum = Math.min(0, minimum); }
        if (minimum === maximum) {
            minimum -= 1;
            maximum += 1;
        }
        var rawRange = Math.max(0.0001, maximum - minimum);
        var step = niceNumber(rawRange / Math.max(2, (targetTicks || 5) - 1), true);
        var niceMin = forceZero && minimum >= 0 ? 0 : Math.floor(minimum / step) * step;
        var niceMax = Math.ceil(maximum / step) * step;
        var pad = Math.max(0, parseInt(paddingSteps || 0, 10) || 0);
        if (pad > 0) {
            if (!(forceZero && minimum >= 0)) {
                niceMin -= step * pad;
            }
            niceMax += step * pad;
        }
        if (niceMin === niceMax) { niceMax = niceMin + step; }
        return { min: niceMin, max: niceMax, step: step };
    }

    function chartZeroScale(values, targetTicks) {
        var clean = finiteValues(values).filter(function (value) { return value >= 0; });
        var maximum = clean.length ? Math.max.apply(null, clean) : 0;
        if (!finite(maximum) || maximum <= 0) {
            return { min: 0, max: 1, step: 0.2 };
        }
        var desiredIntervals = Math.max(3, (targetTicks || 5) - 1);
        var step = niceNumber(maximum / desiredIntervals, true);
        // Évite les graduations peu naturelles comme 3,5 / 7 / 10,5 / 14 mm.
        if (maximum >= 10 && step < 5) { step = 5; }
        else if (maximum >= 5 && step < 2) { step = 2; }
        else if (maximum >= 2 && step < 1) { step = 1; }
        else if (maximum >= 1 && step < 0.5) { step = 0.5; }
        var niceMax = Math.ceil(maximum / step) * step;
        // Toujours laisser un peu d'air au-dessus si le maximum tombe exactement sur la borne.
        if (Math.abs(niceMax - maximum) < 1e-9) { niceMax += step; }
        return { min: 0, max: niceMax, step: step };
    }

    function smoothPath(points) {
        if (!points.length) { return ''; }
        if (points.length === 1) {
            return 'M ' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2);
        }
        var path = 'M ' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2);
        for (var i = 0; i < points.length - 1; i += 1) {
            var current = points[i];
            var next = points[i + 1];
            var middleX = (current.x + next.x) / 2;
            path += ' C ' + middleX.toFixed(2) + ' ' + current.y.toFixed(2)
                + ' ' + middleX.toFixed(2) + ' ' + next.y.toFixed(2)
                + ' ' + next.x.toFixed(2) + ' ' + next.y.toFixed(2);
        }
        return path;
    }

    function chartPointX(index, count, margin, innerWidth) {
        if (count <= 1) { return margin.left + innerWidth / 2; }
        return margin.left + innerWidth * index / (count - 1);
    }

    function chartDayBands(svg, count, margin, innerWidth, innerHeight, meta) {
        if (!meta || !Array.isArray(meta.dayKeys) || !meta.dayKeys.length) { return; }
        var start = 0;
        while (start < count) {
            var key = meta.dayKeys[start];
            var end = start;
            while (end + 1 < count && meta.dayKeys[end + 1] === key) { end += 1; }
            var startX = start === 0
                ? margin.left
                : (chartPointX(start - 1, count, margin, innerWidth) + chartPointX(start, count, margin, innerWidth)) / 2;
            var endX = end === count - 1
                ? margin.left + innerWidth
                : (chartPointX(end, count, margin, innerWidth) + chartPointX(end + 1, count, margin, innerWidth)) / 2;
            var token = (meta.dayTokens && meta.dayTokens[start]) || 'other';
            svg.appendChild(svgElement('rect', {
                x: startX,
                y: margin.top,
                width: Math.max(0, endX - startX),
                height: innerHeight,
                class: 'cep-chart-day-band cep-dayband-' + token
            }));

            // Bandeau supérieur beaucoup plus visible pour identifier la journée.
            svg.appendChild(svgElement('rect', {
                x: startX,
                y: margin.top,
                width: Math.max(0, endX - startX),
                height: 46,
                class: 'cep-chart-day-strip cep-daystrip-' + token
            }));

            // Séparation verticale nette entre deux journées.
            if (start > 0) {
                svg.appendChild(svgElement('line', {
                    x1: startX,
                    y1: margin.top,
                    x2: startX,
                    y2: margin.top + innerHeight,
                    class: 'cep-chart-day-separator cep-dayseparator-' + token
                }));
            }

            if (endX - startX > 72) {
                var dayLabel = meta.dayLabels && meta.dayLabels[start] ? meta.dayLabels[start] : key;
                svg.appendChild(svgElement('text', {
                    x: (startX + endX) / 2,
                    y: margin.top + 31,
                    'text-anchor': 'middle',
                    class: 'cep-chart-day-label cep-daylabel-' + token
                }, dayLabel));
            }
            start = end + 1;
        }
    }

    function chartTickIndexes(count, maximumTicks) {
        if (count <= 0) { return []; }
        if (count <= maximumTicks) {
            return Array.from({ length: count }, function (_, index) { return index; });
        }
        var result = [];
        var step = (count - 1) / (maximumTicks - 1);
        for (var i = 0; i < maximumTicks; i += 1) {
            result.push(Math.round(i * step));
        }
        return result.filter(function (value, index, array) {
            return index === 0 || value !== array[index - 1];
        });
    }

    function appendChartMetrics(container, metrics) {
        var valid = (metrics || []).filter(function (metric) { return metric && metric.value !== '—'; });
        if (!valid.length) { return; }
        var block = document.createElement('div');
        block.className = 'cep-chart-metrics';
        valid.forEach(function (metric) {
            var item = document.createElement('span');
            item.className = 'cep-chart-metric';
            item.appendChild(textSpan(metric.label, 'cep-chart-metric-label'));
            item.appendChild(textSpan(metric.value, 'cep-chart-metric-value'));
            block.appendChild(item);
        });
        container.appendChild(block);
    }

    function appendChartViewport(container, svg) {
        var viewport = document.createElement('div');
        viewport.className = 'cep-chart-viewport';
        var tooltip = document.createElement('div');
        tooltip.className = 'cep-chart-tooltip';
        tooltip.hidden = true;
        tooltip.setAttribute('role', 'status');
        tooltip.setAttribute('aria-live', 'polite');

        function tooltipTarget(node) {
            if (!node || typeof node.closest !== 'function') { return null; }
            return node.closest('[data-cep-tooltip]');
        }

        function placeTooltip(clientX, clientY) {
            var rect = viewport.getBoundingClientRect();
            var x = clientX - rect.left + viewport.scrollLeft + 16;
            var y = clientY - rect.top + viewport.scrollTop - 12;
            tooltip.style.left = Math.max(8, x) + 'px';
            tooltip.style.top = Math.max(8, y) + 'px';
        }

        viewport.addEventListener('pointerover', function (event) {
            var target = tooltipTarget(event.target);
            if (!target) { return; }
            tooltip.textContent = target.getAttribute('data-cep-tooltip') || '';
            tooltip.hidden = false;
            placeTooltip(event.clientX, event.clientY);
        });
        viewport.addEventListener('pointermove', function (event) {
            if (tooltip.hidden) { return; }
            var target = tooltipTarget(event.target);
            if (!target) { return; }
            tooltip.textContent = target.getAttribute('data-cep-tooltip') || '';
            placeTooltip(event.clientX, event.clientY);
        });
        viewport.addEventListener('pointerout', function (event) {
            var from = tooltipTarget(event.target);
            var to = tooltipTarget(event.relatedTarget);
            if (from && from !== to) { tooltip.hidden = true; }
        });
        viewport.addEventListener('focusin', function (event) {
            var target = tooltipTarget(event.target);
            if (!target) { return; }
            tooltip.textContent = target.getAttribute('data-cep-tooltip') || '';
            tooltip.hidden = false;
            var targetRect = target.getBoundingClientRect();
            placeTooltip(targetRect.left + targetRect.width / 2, targetRect.top);
        });
        viewport.addEventListener('focusout', function () {
            tooltip.hidden = true;
        });

        viewport.appendChild(svg);
        viewport.appendChild(tooltip);
        container.appendChild(viewport);
    }

    function seriesStats(values) {
        var clean = finiteValues(values);
        if (!clean.length) { return null; }
        return {
            min: Math.min.apply(null, clean),
            max: Math.max.apply(null, clean),
            first: clean[0],
            last: clean[clean.length - 1]
        };
    }

    function drawExtremaLabels(svg, points, values, formatter, className) {
        var clean = values.map(function (value, index) {
            return finite(value) ? { value: value, index: index } : null;
        }).filter(Boolean);
        if (!clean.length) { return; }
        var minItem = clean.reduce(function (a, b) { return b.value < a.value ? b : a; });
        var maxItem = clean.reduce(function (a, b) { return b.value > a.value ? b : a; });
        var indexes = minItem.index === maxItem.index ? [maxItem.index] : [minItem.index, maxItem.index];
        indexes.forEach(function (index) {
            var point = points[index];
            if (!point) { return; }
            var y = point.y < 54 ? point.y + 22 : point.y - 10;
            svg.appendChild(svgElement('text', {
                x: point.x,
                y: y,
                'text-anchor': 'middle',
                class: 'cep-chart-value-label ' + className
            }, formatter(values[index])));
        });
    }

    function renderLineChart(container, labels, series, options) {
        if (!container) { return; }
        options = options || {};
        container.replaceChildren();
        var all = [];
        series.forEach(function (item) { all = all.concat(item.values); });
        var scale = chartScale(all, Boolean(options.forceZero), options.targetTicks || 5, options.paddingSteps || 0);
        if (!scale) {
            container.appendChild(textSpan('Données indisponibles pour ce diagramme.', 'cep-chart-empty'));
            return;
        }

        var stats = seriesStats(series[0].values);
        if (options.metricMode === 'temperature' && stats) {
            appendChartMetrics(container, [
                { label: 'Mini', value: formatNumber(stats.min, 0) + ' °C' },
                { label: 'Maxi', value: formatNumber(stats.max, 0) + ' °C' },
                { label: 'Amplitude', value: formatNumber(stats.max - stats.min, 0) + ' °C' }
            ]);
        } else if (options.metricMode === 'pressure' && stats) {
            appendChartMetrics(container, [
                { label: 'Mini', value: formatNumber(stats.min, 0) + ' hPa' },
                { label: 'Maxi', value: formatNumber(stats.max, 0) + ' hPa' },
                { label: 'Évolution', value: (stats.last >= stats.first ? '+' : '') + formatNumber(stats.last - stats.first, 0) + ' hPa' }
            ]);
        } else if (options.metricMode === 'wind') {
            var windStats = seriesStats(series[0].values);
            var gustStats = seriesStats(series[1] ? series[1].values : []);
            appendChartMetrics(container, [
                { label: 'Vent max.', value: windStats ? formatNumber(windStats.max, 0) + ' km/h' : '—' },
                { label: 'Rafale max.', value: gustStats ? formatNumber(gustStats.max, 0) + ' km/h' : '—' }
            ]);
        }

        var width = 1280;
        var height = 460;
        var margin = { left: 68, right: 32, top: 58, bottom: 64 };
        var innerWidth = width - margin.left - margin.right;
        var innerHeight = height - margin.top - margin.bottom;
        var svg = svgElement('svg', {
            viewBox: '0 0 ' + width + ' ' + height,
            role: 'img',
            'aria-label': options.ariaLabel || 'Diagramme',
            preserveAspectRatio: 'xMidYMid meet'
        });
        svg.classList.add('cep-chart-svg');
        chartDayBands(svg, labels.length, margin, innerWidth, innerHeight, options.meta);

        var tickValue = Math.ceil((scale.max - scale.min) / scale.step);
        for (var g = 0; g <= tickValue; g += 1) {
            var value = scale.min + g * scale.step;
            var gy = margin.top + innerHeight * (scale.max - value) / (scale.max - scale.min);
            svg.appendChild(svgElement('line', {
                x1: margin.left,
                x2: width - margin.right,
                y1: gy,
                y2: gy,
                class: 'cep-chart-grid'
            }));
            svg.appendChild(svgElement('text', {
                x: margin.left - 9,
                y: gy + 4,
                'text-anchor': 'end',
                class: 'cep-chart-axis'
            }, formatNumber(value, options.decimals || 0)));
        }

        var n = labels.length;
        chartTickIndexes(n, 8).forEach(function (index) {
            var x = chartPointX(index, n, margin, innerWidth);
            var axisLabel = options.meta && options.meta.hourLabels
                ? options.meta.hourLabels[index]
                : labels[index];
            svg.appendChild(svgElement('line', {
                x1: x,
                x2: x,
                y1: margin.top,
                y2: margin.top + innerHeight,
                class: 'cep-chart-grid cep-chart-grid-vertical'
            }));
            svg.appendChild(svgElement('text', {
                x: x,
                y: height - 18,
                'text-anchor': index === 0 ? 'start' : (index === n - 1 ? 'end' : 'middle'),
                class: 'cep-chart-axis cep-chart-xaxis'
            }, axisLabel));
        });

        var seriesPoints = [];
        series.forEach(function (item, seriesIndex) {
            var points = [];
            item.values.forEach(function (value, index) {
                if (!finite(value)) { points[index] = null; return; }
                points[index] = {
                    x: chartPointX(index, n, margin, innerWidth),
                    y: margin.top + innerHeight * (scale.max - value) / (scale.max - scale.min),
                    value: value,
                    index: index
                };
            });
            seriesPoints.push(points);

            var segments = [];
            var current = [];
            points.forEach(function (point) {
                if (!point) {
                    if (current.length) { segments.push(current); current = []; }
                    return;
                }
                current.push(point);
            });
            if (current.length) { segments.push(current); }

            if (series.length === 1 && options.fillArea) {
                segments.forEach(function (segment) {
                    if (!segment.length) { return; }
                    var d = smoothPath(segment)
                        + ' L ' + segment[segment.length - 1].x.toFixed(2) + ' ' + (margin.top + innerHeight).toFixed(2)
                        + ' L ' + segment[0].x.toFixed(2) + ' ' + (margin.top + innerHeight).toFixed(2)
                        + ' Z';
                    svg.appendChild(svgElement('path', {
                        d: d,
                        class: 'cep-chart-area ' + item.className
                    }));
                });
            }

            segments.forEach(function (segment) {
                svg.appendChild(svgElement('path', {
                    d: smoothPath(segment),
                    class: 'cep-chart-line ' + item.className,
                    fill: 'none'
                }));
            });

            points.forEach(function (point, index) {
                if (!point) { return; }
                var tooltipLabel = labels[index] + ' — ' + item.label + ' : '
                    + formatNumber(point.value, options.decimals || 0)
                    + (options.unit ? ' ' + options.unit : '');
                var attrs = {
                    cx: point.x,
                    cy: point.y,
                    r: options.showPoints === false ? 10 : 5.4,
                    class: (options.showPoints === false ? 'cep-chart-hitpoint ' : 'cep-chart-point ') + item.className,
                    tabindex: 0,
                    'aria-label': tooltipLabel,
                    'data-cep-tooltip': tooltipLabel
                };
                if (options.showPoints === false) {
                    attrs.fill = 'transparent';
                    attrs.stroke = 'none';
                    attrs.opacity = '0';
                }
                var circle = svgElement('circle', attrs);
                svg.appendChild(circle);
            });

            if (series.length === 1 && options.showExtrema === true) {
                drawExtremaLabels(
                    svg,
                    points,
                    item.values,
                    function (value) {
                        return formatNumber(value, options.decimals || 0) + (options.unit ? ' ' + options.unit : '');
                    },
                    item.className
                );
            }
        });

        if (options.bandBetween && seriesPoints.length >= 2) {
            var upper = seriesPoints[1];
            var lower = seriesPoints[0];
            var upperPoints = [];
            var lowerPoints = [];
            for (var i = 0; i < n; i += 1) {
                if (upper[i] && lower[i]) {
                    upperPoints.push(upper[i]);
                    lowerPoints.push(lower[i]);
                }
            }
            if (upperPoints.length > 1 && upperPoints.length === lowerPoints.length) {
                var area = smoothPath(upperPoints);
                var reversed = lowerPoints.slice().reverse();
                area += ' L ' + reversed[0].x.toFixed(2) + ' ' + reversed[0].y.toFixed(2);
                for (var j = 1; j < reversed.length; j += 1) {
                    area += ' L ' + reversed[j].x.toFixed(2) + ' ' + reversed[j].y.toFixed(2);
                }
                area += ' Z';
                var envelope = svgElement('path', {
                    d: area,
                    class: 'cep-chart-wind-envelope'
                });
                var firstLine = svg.querySelector('.cep-chart-line');
                if (firstLine) { svg.insertBefore(envelope, firstLine); }
                else { svg.appendChild(envelope); }
            }
        }

        if (series.length > 1) {
            var legend = svgElement('g', { class: 'cep-chart-legend' });
            series.forEach(function (item, index) {
                var x = margin.left + index * 165;
                legend.appendChild(svgElement('line', {
                    x1: x,
                    x2: x + 28,
                    y1: 17,
                    y2: 17,
                    class: 'cep-chart-line ' + item.className
                }));
                legend.appendChild(svgElement('text', {
                    x: x + 36,
                    y: 21,
                    class: 'cep-chart-axis cep-chart-legend-text'
                }, item.label));
            });
            svg.appendChild(legend);
        }
        appendChartViewport(container, svg);
    }

    function rainVisualClass(value) {
        if (!finite(value) || value < 0.1) { return 'cep-chart-rain-zero'; }
        if (value >= 15) { return 'cep-chart-rain-intense'; }
        if (value >= 5) { return 'cep-chart-rain-strong'; }
        if (value >= 2) { return 'cep-chart-rain-moderate'; }
        if (value >= 0.5) { return 'cep-chart-rain-light'; }
        return 'cep-chart-rain-trace';
    }

    function renderRainChart(container, labels, rainValues, cumulativeValues, options) {
        if (!container) { return; }
        options = options || {};
        container.replaceChildren();
        var rainClean = finiteValues(rainValues);
        var cumulativeClean = finiteValues(cumulativeValues);
        if (!rainClean.length && !cumulativeClean.length) {
            container.appendChild(textSpan('Données indisponibles pour ce diagramme.', 'cep-chart-empty'));
            return;
        }

        var total = cumulativeClean.length ? cumulativeClean[cumulativeClean.length - 1] : 0;
        var rainMaxValue = rainClean.length ? Math.max.apply(null, rainClean) : 0;
        appendChartMetrics(container, [
            { label: 'Cumul', value: formatNumber(total, 1) + ' mm' },
            { label: 'Max. par pas', value: formatNumber(rainMaxValue, 1) + ' mm' }
        ]);

        var width = 1280;
        var height = 460;
        var margin = { left: 68, right: 78, top: 58, bottom: 64 };
        var innerWidth = width - margin.left - margin.right;
        var innerHeight = height - margin.top - margin.bottom;
        var combinedScaleValues = [0].concat(rainClean.length ? rainClean : [0], cumulativeClean.length ? cumulativeClean : [0]);
        var rainScale = chartZeroScale(combinedScaleValues, 6);
        var cumScale = rainScale;
        var svg = svgElement('svg', {
            viewBox: '0 0 ' + width + ' ' + height,
            role: 'img',
            'aria-label': 'Diagramme des précipitations et du cumul',
            preserveAspectRatio: 'xMidYMid meet'
        });
        svg.classList.add('cep-chart-svg');
        chartDayBands(svg, labels.length, margin, innerWidth, innerHeight, options.meta);

        var rainTickCount = Math.round((rainScale.max - rainScale.min) / rainScale.step);
        for (var g = 0; g <= rainTickCount; g += 1) {
            var rainAxis = rainScale.min + g * rainScale.step;
            var y = margin.top + innerHeight * (rainScale.max - rainAxis) / Math.max(0.001, rainScale.max - rainScale.min);
            svg.appendChild(svgElement('line', {
                x1: margin.left,
                x2: width - margin.right,
                y1: y,
                y2: y,
                class: 'cep-chart-grid'
            }));
            svg.appendChild(svgElement('text', {
                x: margin.left - 9,
                y: y + 5,
                'text-anchor': 'end',
                class: 'cep-chart-axis'
            }, formatNumber(rainAxis, rainScale.step < 1 ? 1 : 0)));
        }

        var cumTickCount = Math.round((cumScale.max - cumScale.min) / cumScale.step);
        for (var cg = 0; cg <= cumTickCount; cg += 1) {
            var cumAxis = cumScale.min + cg * cumScale.step;
            var cy = margin.top + innerHeight * (cumScale.max - cumAxis) / Math.max(0.001, cumScale.max - cumScale.min);
            svg.appendChild(svgElement('text', {
                x: width - margin.right + 9,
                y: cy + 5,
                'text-anchor': 'start',
                class: 'cep-chart-axis cep-chart-axis-cumulative'
            }, formatNumber(cumAxis, cumScale.step < 1 ? 1 : 0)));
        }


        var n = labels.length;
        var slot = n ? innerWidth / n : innerWidth;
        rainValues.forEach(function (value, index) {
            if (!finite(value) || value <= 0) { return; }
            var barHeight = innerHeight * (Math.min(value, rainScale.max) - rainScale.min) / Math.max(0.001, rainScale.max - rainScale.min);
            var x = margin.left + index * slot + slot * 0.16;
            var y = margin.top + innerHeight - barHeight;
            var rainTooltip = labels[index] + ' — pluie depuis l’échéance précédente : ' + formatNumber(value, 1) + ' mm';
            var bar = svgElement('rect', {
                x: x,
                y: y,
                width: Math.max(3, slot * 0.68),
                height: barHeight,
                rx: Math.min(6, slot * 0.18),
                class: 'cep-chart-rain-bar ' + rainVisualClass(value),
                tabindex: 0,
                'aria-label': rainTooltip,
                'data-cep-tooltip': rainTooltip
            });
            svg.appendChild(bar);
        });

        var cumulativePoints = [];
        cumulativeValues.forEach(function (value, index) {
            if (!finite(value)) { cumulativePoints[index] = null; return; }
            cumulativePoints[index] = {
                x: chartPointX(index, n, margin, innerWidth),
                y: margin.top + innerHeight * (cumScale.max - value) / Math.max(0.001, cumScale.max - cumScale.min),
                value: value
            };
        });
        var cleanPoints = cumulativePoints.filter(Boolean);
        if (cleanPoints.length) {
            svg.appendChild(svgElement('path', {
                d: smoothPath(cleanPoints),
                class: 'cep-chart-line cep-series-rain-cumulative',
                fill: 'none'
            }));
            cumulativePoints.forEach(function (point, index) {
                if (!point) { return; }
                var cumulativeTooltip = labels[index] + ' — cumul : ' + formatNumber(point.value, 1) + ' mm';
                var hitPoint = svgElement('circle', {
                    cx: point.x,
                    cy: point.y,
                    r: 11,
                    class: 'cep-chart-hitpoint cep-series-rain-cumulative',
                    tabindex: 0,
                    'aria-label': cumulativeTooltip,
                    'data-cep-tooltip': cumulativeTooltip,
                    fill: 'transparent',
                    stroke: 'none',
                    opacity: '0'
                });
                svg.appendChild(hitPoint);
            });
        }

        chartTickIndexes(n, 8).forEach(function (index) {
            var x = chartPointX(index, n, margin, innerWidth);
            var axisLabel = options.meta && options.meta.hourLabels
                ? options.meta.hourLabels[index]
                : labels[index];
            svg.appendChild(svgElement('text', {
                x: x,
                y: height - 18,
                'text-anchor': index === 0 ? 'start' : (index === n - 1 ? 'end' : 'middle'),
                class: 'cep-chart-axis cep-chart-xaxis'
            }, axisLabel));
        });

        var legend = svgElement('g', { class: 'cep-chart-legend' });
        legend.appendChild(svgElement('rect', {
            x: margin.left,
            y: 10,
            width: 20,
            height: 11,
            rx: 4,
            class: 'cep-chart-rain-bar cep-chart-rain-light'
        }));
        legend.appendChild(svgElement('text', {
            x: margin.left + 28,
            y: 21,
            class: 'cep-chart-axis cep-chart-legend-text'
        }, 'Pluie par échéance'));
        legend.appendChild(svgElement('line', {
            x1: margin.left + 142,
            x2: margin.left + 172,
            y1: 17,
            y2: 17,
            class: 'cep-chart-line cep-series-rain-cumulative'
        }));
        legend.appendChild(svgElement('text', {
            x: margin.left + 180,
            y: 21,
            class: 'cep-chart-axis cep-chart-legend-text'
        }, 'Cumul'));
        svg.appendChild(legend);
        appendChartViewport(container, svg);
    }

    function createCell(tag, label, className) {
        var cell = document.createElement(tag);
        if (label) {
            cell.setAttribute('data-label', label);
        }
        if (className) {
            cell.className = className;
        }
        return cell;
    }

    function textSpan(text, className) {
        var span = document.createElement('span');
        span.textContent = text;
        if (className) {
            span.className = className;
        }
        return span;
    }

    function fetchJson(url, options) {
        return fetch(url, options || {}).then(function (response) {
            if (!response.ok) {
                throw new Error('Réponse HTTP ' + response.status);
            }
            return response.json();
        });
    }

    function initApp(app) {
        var baseUrl = (app.dataset.baseUrl || '').replace(/\/+$/, '');
        var defaultCode = app.dataset.defaultCode || '66136';
        var defaultDepartment = app.dataset.defaultDepartment || '66';
        var defaultName = app.dataset.defaultName || 'Perpignan';
        var hours = Math.max(3, Math.min(240, parseInt(app.dataset.hours || '240', 10)));
        var timezone = app.dataset.timezone || 'Europe/Paris';
        var titlePrefix = app.dataset.titlePrefix || 'Prévisions CEP';

        var input = app.querySelector('.cep-city-input');
        var locateButton = app.querySelector('[data-cep-locate]');
        var results = app.querySelector('.cep-search-results');
        var status = app.querySelector('.cep-search-status');
        var generalBody = app.querySelector('[data-cep-body-general]');
        var stormBody = app.querySelector('[data-cep-body-storms]');
        var stormSummary = app.querySelector('[data-cep-storm-summary]');
        var snowBody = app.querySelector('[data-cep-body-snow]');
        var snowSummary = app.querySelector('[data-cep-snow-summary]');
        var tabs = Array.prototype.slice.call(app.querySelectorAll('[data-cep-tab]'));
        var panels = Array.prototype.slice.call(app.querySelectorAll('[data-cep-panel]'));
        var title = app.querySelector('[data-cep-title]');
        var altitudeLine = app.querySelector('[data-cep-altitude]');
        var meta = app.querySelector('[data-cep-meta]');
        var generated = app.querySelector('[data-cep-generated]');
        var stale = app.querySelector('[data-cep-stale]');
        var stormTopScroll = app.querySelector('[data-cep-top-scroll="storms"]');
        var stormScrollWrap = app.querySelector('[data-cep-scroll-wrap="storms"]');
        var stormTable = app.querySelector('.cep-storm-table');
        var snowTopScroll = app.querySelector('[data-cep-top-scroll="snow"]');
        var snowScrollWrap = app.querySelector('[data-cep-scroll-wrap="snow"]');
        var snowTable = app.querySelector('.cep-snow-table');
        var chartTemperature = app.querySelector('[data-cep-chart-temperature]');
        var chartPressure = app.querySelector('[data-cep-chart-pressure]');
        var chartRain = app.querySelector('[data-cep-chart-rain]');
        var chartWind = app.querySelector('[data-cep-chart-wind]');
        var chartTitleTemperature = app.querySelector('[data-cep-chart-title-temperature]');
        var chartTitlePressure = app.querySelector('[data-cep-chart-title-pressure]');
        var chartTitleRain = app.querySelector('[data-cep-chart-title-rain]');
        var chartTitleWind = app.querySelector('[data-cep-chart-title-wind]');
        var rainTotal = app.querySelector('[data-cep-rain-total]');

        var indexData = null;
        var departmentCache = new Map();
        var debounceTimer = null;
        var searchController = null;
        var resultButtons = [];
        var activeResult = -1;
        var selectedMapFocus = null;

        var weekdayFormat = dateFormatter(timezone, { weekday: 'short' });
        var shortDateFormat = dateFormatter(timezone, { day: '2-digit', month: '2-digit' });
        var dayKeyFormat = dateFormatter(timezone, { year: 'numeric', month: '2-digit', day: '2-digit' });
        var hourFormat = dateFormatter(timezone, {
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });
        var fullFormat = dateFormatter(timezone, {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });

        function localDayKey(date) {
            return dayKeyFormat.format(date);
        }

        function weekdayToken(date) {
            var label = weekdayFormat.format(date).toLocaleLowerCase('fr-FR');
            if (label.indexOf('lun') === 0) { return 'mon'; }
            if (label.indexOf('mar') === 0) { return 'tue'; }
            if (label.indexOf('mer') === 0) { return 'wed'; }
            if (label.indexOf('jeu') === 0) { return 'thu'; }
            if (label.indexOf('ven') === 0) { return 'fri'; }
            if (label.indexOf('sam') === 0) { return 'sat'; }
            if (label.indexOf('dim') === 0) { return 'sun'; }
            return 'other';
        }

        function makeDayCell(date, rowSpan) {
            var cell = createCell('th', 'Date', 'cep-day-cell cep-day-' + weekdayToken(date));
            cell.scope = 'rowgroup';
            cell.rowSpan = rowSpan;
            cell.appendChild(textSpan(weekdayFormat.format(date), 'cep-day-weekday'));
            cell.appendChild(textSpan(shortDateFormat.format(date), 'cep-day-date'));
            return cell;
        }

        function syncTopScroll(topScroll, scrollWrap, table) {
            if (!topScroll || !scrollWrap || !table) { return; }
            var inner = topScroll.firstElementChild;
            if (!inner) { return; }
            inner.style.width = table.scrollWidth + 'px';
            topScroll.hidden = table.scrollWidth <= scrollWrap.clientWidth + 2;
        }

        function updateStormTopScroll() {
            syncTopScroll(stormTopScroll, stormScrollWrap, stormTable);
        }

        function updateSnowTopScroll() {
            syncTopScroll(snowTopScroll, snowScrollWrap, snowTable);
        }

        function bindTopScroll(topScroll, scrollWrap, updater) {
            if (!topScroll || !scrollWrap) { return; }
            topScroll.addEventListener('scroll', function () {
                scrollWrap.scrollLeft = topScroll.scrollLeft;
            });
            scrollWrap.addEventListener('scroll', function () {
                topScroll.scrollLeft = scrollWrap.scrollLeft;
            });
            window.addEventListener('resize', updater);
        }

        bindTopScroll(stormTopScroll, stormScrollWrap, updateStormTopScroll);
        bindTopScroll(snowTopScroll, snowScrollWrap, updateSnowTopScroll);

        function setStatus(message, error) {
            status.textContent = message;
            status.classList.toggle('cep-search-error', Boolean(error));
        }

        function setActiveView(view) {
            tabs.forEach(function (button) {
                var active = button.dataset.cepTab === view;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            panels.forEach(function (panel) {
                panel.hidden = panel.dataset.cepPanel !== view;
            });
            app.dataset.activeView = view;
            if (view === 'storms') { window.requestAnimationFrame(updateStormTopScroll); }
            if (view === 'snow') { window.requestAnimationFrame(updateSnowTopScroll); }
            if (view === 'map' && selectedMapFocus) {
                window.requestAnimationFrame(function () {
                    var mapApp = app.querySelector('[data-cepm-app]');
                    if (mapApp) {
                        mapApp.dispatchEvent(new CustomEvent('cepm:focus-location', {
                            detail: selectedMapFocus
                        }));
                    }
                });
            }
        }

        tabs.forEach(function (button) {
            button.addEventListener('click', function () {
                setActiveView(button.dataset.cepTab || 'general');
            });
        });
        app.dataset.activeView = 'map';

        function putMessage(body, message, error, colspan) {
            if (!body) { return; }
            body.replaceChildren();
            var row = document.createElement('tr');
            var cell = createCell('td', '', error ? 'cep-loading cep-load-error' : 'cep-loading');
            cell.colSpan = colspan;
            cell.textContent = message;
            row.appendChild(cell);
            body.appendChild(row);
        }

        function showTableMessage(message, error) {
            putMessage(generalBody, message, error, 10);
            putMessage(stormBody, message, error, 14);
            putMessage(snowBody, message, error, 13);
            if (stormSummary) {
                stormSummary.textContent = message;
                stormSummary.classList.toggle('cep-storm-summary-warning', Boolean(error));
            }
            if (snowSummary) {
                snowSummary.textContent = message;
                snowSummary.classList.toggle('cep-snow-summary-warning', Boolean(error));
            }
        }

        function closeResults() {
            results.hidden = true;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
            resultButtons = [];
            activeResult = -1;
        }

        function setActiveResult(position) {
            if (!resultButtons.length) {
                return;
            }
            activeResult = Math.max(0, Math.min(resultButtons.length - 1, position));
            resultButtons.forEach(function (button, index) {
                var active = index === activeResult;
                button.classList.toggle('is-active', active);
                button.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            var selected = resultButtons[activeResult];
            input.setAttribute('aria-activedescendant', selected.id);
            selected.scrollIntoView({ block: 'nearest' });
        }

        function loadIndex() {
            return fetchJson(baseUrl + '/index.json', { cache: 'no-cache' })
                .then(function (payload) {
                    if (!payload || payload.status !== 'ok' || !payload.departments) {
                        throw new Error('Index national CEP invalide');
                    }
                    indexData = payload;
                    var run = payload.model && payload.model.run_time
                        ? fullFormat.format(new Date(payload.model.run_time)).replace(':', 'h')
                        : 'indéterminé';
                    var resolution = payload.model && payload.model.resolution_km
                        ? formatNumber(payload.model.resolution_km, 1) + ' km'
                        : '—';
                    meta.textContent = 'Run du ' + run + ' • résolution ' + resolution +
                        ((payload.model && payload.model.storm_diagnostics) ? ' • diagnostics orages + neige CEP' : '');

                    if (payload.generated_at) {
                        generated.textContent = 'Mise à jour du tableau : ' +
                            fullFormat.format(new Date(payload.generated_at)).replace(':', 'h');
                        stale.hidden = (Date.now() - new Date(payload.generated_at).getTime()) <= 8 * 3600000;
                    }
                    return payload;
                });
        }

        function loadDepartment(code) {
            var normalized = String(code || '').toUpperCase();
            if (departmentCache.has(normalized)) {
                return departmentCache.get(normalized);
            }
            if (!indexData || !indexData.departments[normalized]) {
                return Promise.reject(new Error('Département hors couverture CEP'));
            }
            var relativeFile = indexData.departments[normalized].file;
            var promise = fetchJson(baseUrl + '/' + relativeFile, { cache: 'default' })
                .then(function (payload) {
                    if (!payload || payload.status !== 'ok' || !Array.isArray(payload.communes)) {
                        throw new Error('Fichier départemental invalide');
                    }
                    return payload;
                })
                .catch(function (error) {
                    departmentCache.delete(normalized);
                    throw error;
                });
            departmentCache.set(normalized, promise);
            return promise;
        }

        function renderForecast(departmentData, commune) {
            var pointId = Number(commune[6]);
            var lowerTime = Date.now() - 3600000;
            var rawForecasts = (departmentData.forecast || []).filter(function (step) {
                return Array.isArray(step) && new Date(step[0]).getTime() >= lowerTime;
            }).slice(0, hours);

            var columns = departmentData.columns && Array.isArray(departmentData.columns.values)
                ? departmentData.columns.values
                : LEGACY_COLUMNS;
            var columnIndex = {};
            columns.forEach(function (name, index) { columnIndex[name] = index; });
            function value(values, name, fallback) {
                var index = Object.prototype.hasOwnProperty.call(columnIndex, name)
                    ? columnIndex[name]
                    : fallback;
                return typeof index === 'number' ? values[index] : null;
            }
            function appendNumber(row, label, number, decimals, suffix, className) {
                var cell = createCell('td', label, className || '');
                cell.textContent = formatNumber(number, decimals) + (finite(number) ? (suffix || '') : '');
                row.appendChild(cell);
                return cell;
            }
            function appendHazard(row, label, code) {
                var numeric = finite(code) ? Number(code) : null;
                var cell = createCell('td', label, numeric === null ? '' : 'cep-hazard cep-hazard-' + numeric);
                cell.textContent = numeric === null ? '—' : (HAZARD_RISKS[numeric] || '—');
                row.appendChild(cell);
            }

            var forecasts = rawForecasts.filter(function (step) {
                return step[1] && Array.isArray(step[1][pointId]);
            });
            if (!forecasts.length) {
                showTableMessage('Aucune échéance CEP disponible pour cette commune.', true);
                return;
            }

            var dayCounts = {};
            forecasts.forEach(function (step) {
                var key = localDayKey(new Date(step[0]));
                dayCounts[key] = (dayCounts[key] || 0) + 1;
            });

            generalBody.replaceChildren();
            stormBody.replaceChildren();
            snowBody.replaceChildren();
            var previousGeneralDay = '';
            var previousStormDay = '';
            var previousSnowDay = '';
            var maxThunderRisk = null;
            var maxSnowRisk = null;
            var hasStormColumns = Object.prototype.hasOwnProperty.call(columnIndex, 'thunder_risk_code');
            var hasSnowColumns = Object.prototype.hasOwnProperty.call(columnIndex, 'snow_risk_code')
                && Object.prototype.hasOwnProperty.call(columnIndex, 'snowfall_mm')
                && Object.prototype.hasOwnProperty.call(columnIndex, 'snow_depth_cm');
            var chartLabels = [];
            var chartHourLabels = [];
            var chartDayKeys = [];
            var chartDayTokens = [];
            var chartDayLabels = [];
            var chartTemps = [];
            var chartPressures = [];
            var chartRainValues = [];
            var chartRainCumulative = [];
            var chartWindValues = [];
            var chartGustValues = [];
            var cumulativeRain = 0;

            forecasts.forEach(function (step, currentIndex) {
                var date = new Date(step[0]);
                var values = step[1][pointId];
                var dayKey = localDayKey(date);
                var temp = value(values, 'temperature_c', 0);
                var rain = value(values, 'precipitation_mm', 2);
                var wind = value(values, 'wind_speed_kmh', 4);
                var gust = value(values, 'wind_gust_kmh', 6);
                var windDisplay = roundUpFive(wind);
                var gustDisplay = roundUpFive(gust);

                chartLabels.push(shortDateFormat.format(date) + ' ' + hourFormat.format(date).replace(':', 'h'));
                chartHourLabels.push(hourFormat.format(date).replace(':', 'h'));
                chartDayKeys.push(dayKey);
                chartDayTokens.push(weekdayToken(date));
                chartDayLabels.push(weekdayFormat.format(date) + ' ' + shortDateFormat.format(date));
                chartTemps.push(temp);
                chartPressures.push(value(values, 'pressure_hpa', 7));
                chartRainValues.push(rain);
                cumulativeRain += finite(rain) ? Math.max(0, Number(rain)) : 0;
                chartRainCumulative.push(cumulativeRain);
                chartWindValues.push(windDisplay);
                chartGustValues.push(gustDisplay);

                // Tableau 1 — prévisions générales.
                var row = document.createElement('tr');
                if (dayKey !== previousGeneralDay) {
                    row.classList.add('cep-new-day');
                    row.appendChild(makeDayCell(date, dayCounts[dayKey]));
                    previousGeneralDay = dayKey;
                }

                var hourCell = createCell('td', 'Heure', 'cep-hour cep-hour-' + weekdayToken(date));
                hourCell.textContent = hourFormat.format(date);
                row.appendChild(hourCell);

                var conditionCode = value(values, 'condition_code', 9);
                var condition = CONDITIONS[Number(conditionCode)] || CONDITIONS[0];
                var conditionCell = createCell('td', 'Temps', 'cep-condition');
                conditionCell.appendChild(textSpan(condition.icon, 'cep-icon'));
                conditionCell.appendChild(textSpan(condition.label));
                row.appendChild(conditionCell);

                var temperatureCell = createCell('td', 'Température', 'cep-temperature ' + temperatureClass(temp));
                temperatureCell.textContent = formatNumber(temp, 0) + (finite(temp) ? ' °C' : '');
                row.appendChild(temperatureCell);

                appendNumber(row, 'Humidité', value(values, 'humidity_pct', 1), 0, ' %');
                appendNumber(row, 'Pluie', rain, 1, ' mm', rainClass(rain));
                appendNumber(row, 'Nuages', value(values, 'cloud_cover_pct', 3), 0, ' %');

                var windCell = createCell('td', 'Vent', 'cep-wind-cell ' + windForceClass(windDisplay));
                var windStrong = document.createElement('strong');
                windStrong.textContent = formatNumber(windDisplay, 0) + (finite(windDisplay) ? ' km/h' : '');
                windCell.appendChild(windStrong);
                var directionDegrees = value(values, 'wind_direction_deg', 5);
                var direction = windDirection(directionDegrees);
                if (direction) {
                    var directionBadge = document.createElement('span');
                    directionBadge.className = 'cep-direction ' + windForceClass(windDisplay);
                    directionBadge.title = 'Vent de ' + direction + ' • ' + formatNumber(directionDegrees, 0) + '°';
                    var arrow = textSpan('➜', 'cep-wind-arrow');
                    arrow.style.transform = 'rotate(' + ((Number(directionDegrees) + 180) % 360) + 'deg)';
                    directionBadge.appendChild(arrow);
                    directionBadge.appendChild(textSpan(direction, 'cep-wind-label'));
                    windCell.appendChild(directionBadge);
                }
                row.appendChild(windCell);

                var gustCell = createCell('td', 'Rafales', gustClass(gustDisplay));
                var gustStrong = document.createElement('strong');
                gustStrong.textContent = formatNumber(gustDisplay, 0) + (finite(gustDisplay) ? ' km/h' : '');
                gustCell.appendChild(gustStrong);
                row.appendChild(gustCell);
                appendNumber(row, 'Pression', value(values, 'pressure_hpa', 7), 0, ' hPa');
                generalBody.appendChild(row);

                // Tableau 2 — diagnostic orageux.
                var stormRow = document.createElement('tr');
                if (dayKey !== previousStormDay) {
                    stormRow.classList.add('cep-new-day');
                    stormRow.appendChild(makeDayCell(date, dayCounts[dayKey]));
                    previousStormDay = dayKey;
                }
                var stormHour = createCell('td', 'Heure', 'cep-hour cep-hour-' + weekdayToken(date));
                stormHour.textContent = hourFormat.format(date);
                stormRow.appendChild(stormHour);

                var thunderCode = value(values, 'thunder_risk_code');
                if (finite(thunderCode)) {
                    maxThunderRisk = maxThunderRisk === null ? Number(thunderCode) : Math.max(maxThunderRisk, Number(thunderCode));
                }
                var thunder = finite(thunderCode) ? THUNDER_RISKS[Number(thunderCode)] : null;
                var thunderCell = createCell('td', 'Risque orage', thunder ? 'cep-thunder-risk cep-thunder-' + Number(thunderCode) : '');
                if (thunder) {
                    thunderCell.appendChild(textSpan(thunder.icon + ' ', 'cep-risk-icon'));
                    thunderCell.appendChild(textSpan(thunder.label, 'cep-risk-label'));
                } else {
                    thunderCell.textContent = '—';
                }
                stormRow.appendChild(thunderCell);

                var cape = value(values, 'cape_jkg');
                var capeCell = createCell('td', 'CAPE', finite(cape) && cape >= 1500 ? 'cep-cape-high' : (finite(cape) && cape >= 500 ? 'cep-cape-mid' : ''));
                capeCell.textContent = finite(cape) && Number(cape) >= 25 ? formatNumber(cape, 0) + ' J/kg' : '—';
                capeCell.title = 'MUCAPE instantanée directement produite par CEP ; les valeurs quasi nulles ne sont pas affichées.';
                stormRow.appendChild(capeCell);
                appendNumber(stormRow, 'Intensité pluie', value(values, 'precipitation_rate_mmh'), 2, ' mm/h');
                appendNumber(stormRow, 'LCL', value(values, 'lcl_m'), 0, ' m');

                var lightning = value(values, 'lightning_score');
                appendNumber(stormRow, 'Foudre', lightning, 0, '/100', finite(lightning) && lightning >= 60 ? 'cep-lightning-high' : '');
                appendHazard(stormRow, 'Grêle', value(values, 'hail_risk_code'));
                appendNumber(stormRow, 'Pluie conv.', value(values, 'convective_precipitation_mm'), 1, ' mm');
                appendNumber(stormRow, 'Graupel', value(values, 'graupel_mm'), 2, ' mm');
                appendNumber(stormRow, 'Pluie / pas', rain, 1, ' mm', rainClass(rain));
                appendNumber(stormRow, 'Rafales', gustDisplay, 0, ' km/h', gustClass(gustDisplay));
                var stormTypeCode = value(values, 'storm_type_code');
                var stormTypeCell = createCell('td', 'Type d’orage', 'cep-storm-type');
                stormTypeCell.textContent = finite(stormTypeCode) ? (STORM_TYPES[Number(stormTypeCode)] || 'Indéterminé') : '—';
                stormRow.appendChild(stormTypeCell);

                var detailsCell = createCell('td', 'Détails', 'cep-details-cell');
                var detailsButton = document.createElement('button');
                detailsButton.type = 'button';
                detailsButton.className = 'cep-details-button';
                detailsButton.textContent = 'Afficher';
                detailsButton.setAttribute('aria-expanded', 'false');
                detailsCell.appendChild(detailsButton);

                var advanced = document.createElement('div');
                advanced.className = 'cep-advanced-list cep-details-inline';
                advanced.hidden = true;
                [
                    ['MUCAPE directe', value(values, 'cape_jkg'), 0, ' J/kg'],
                    ['Réflectivité maximale', value(values, 'reflectivity_dbz'), 0, ' dBZ'],
                    ['LCL estimé', value(values, 'lcl_m'), 0, ' m'],
                    ['Pluie cumulée depuis le run', value(values, 'precipitation_total_mm'), 1, ' mm'],
                    ['Nuages bas', value(values, 'cloud_low_pct'), 0, ' %'],
                    ['Nuages moyens', value(values, 'cloud_mid_pct'), 0, ' %'],
                    ['Nuages élevés', value(values, 'cloud_high_pct'), 0, ' %']
                ].forEach(function (item) {
                    var box = document.createElement('div');
                    box.className = 'cep-advanced-item';
                    box.appendChild(textSpan(item[0], 'cep-advanced-label'));
                    box.appendChild(textSpan(finite(item[1]) ? formatNumber(item[1], item[2]) + item[3] : '—', 'cep-advanced-value'));
                    advanced.appendChild(box);
                });
                detailsCell.appendChild(advanced);
                stormRow.appendChild(detailsCell);
                stormBody.appendChild(stormRow);

                detailsButton.addEventListener('click', function () {
                    var open = advanced.hidden;
                    advanced.hidden = !open;
                    detailsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
                    detailsButton.textContent = open ? 'Masquer' : 'Afficher';
                    window.requestAnimationFrame(updateStormTopScroll);
                });

                // Tableau 3 — risque de neige.
                var snowRow = document.createElement('tr');
                if (dayKey !== previousSnowDay) {
                    snowRow.classList.add('cep-new-day');
                    snowRow.appendChild(makeDayCell(date, dayCounts[dayKey]));
                    previousSnowDay = dayKey;
                }
                var snowHour = createCell('td', 'Heure', 'cep-hour cep-hour-' + weekdayToken(date));
                snowHour.textContent = hourFormat.format(date);
                snowRow.appendChild(snowHour);

                var snowRiskCode = value(values, 'snow_risk_code');
                if (finite(snowRiskCode)) {
                    maxSnowRisk = maxSnowRisk === null ? Number(snowRiskCode) : Math.max(maxSnowRisk, Number(snowRiskCode));
                }
                var snowRisk = finite(snowRiskCode) ? SNOW_RISKS[Number(snowRiskCode)] : null;
                var snowRiskCell = createCell('td', 'Risque neige', snowRisk ? 'cep-snow-risk cep-snow-' + Number(snowRiskCode) : '');
                if (snowRisk) {
                    snowRiskCell.appendChild(textSpan(snowRisk.icon + ' ', 'cep-risk-icon'));
                    snowRiskCell.appendChild(textSpan(snowRisk.label, 'cep-risk-label'));
                } else { snowRiskCell.textContent = '—'; }
                snowRow.appendChild(snowRiskCell);

                var phaseCode = value(values, 'snow_phase_code');
                var phaseCell = createCell('td', 'Phase');
                phaseCell.textContent = finite(phaseCode) ? (SNOW_PHASE[Number(phaseCode)] || '—') : '—';
                snowRow.appendChild(phaseCell);
                appendNumber(snowRow, 'Neige / pas', value(values, 'snow_fresh_cm'), 1, ' cm');

                function forwardSnowSum(startIndex, windowHours) {
                    var total = 0;
                    var found = false;
                    for (var offset = 0; offset < windowHours && startIndex + offset < forecasts.length; offset += 1) {
                        var future = forecasts[startIndex + offset];
                        var futureValues = future[1] && future[1][pointId];
                        if (!Array.isArray(futureValues)) { continue; }
                        var snowValue = value(futureValues, 'snow_fresh_cm');
                        if (finite(snowValue)) { total += Number(snowValue); found = true; }
                    }
                    return found ? total : null;
                }
                appendNumber(snowRow, 'Neige 3 h', forwardSnowSum(currentIndex, 3), 1, ' cm');
                appendNumber(snowRow, 'Neige 6 h', forwardSnowSum(currentIndex, 6), 1, ' cm');

                var stickCode = value(values, 'snow_stick_risk_code');
                var stickCell = createCell('td', 'Tenue', finite(stickCode) ? 'cep-stick cep-stick-' + Number(stickCode) : '');
                stickCell.textContent = finite(stickCode) ? (SNOW_STICK[Number(stickCode)] || '—') : '—';
                snowRow.appendChild(stickCell);

                appendNumber(snowRow, 'Pression', value(values, 'pressure_hpa', 7), 0, ' hPa');
                appendNumber(snowRow, 'Humidité', value(values, 'humidity_pct', 1), 0, ' %');

                var snowWindCell = createCell('td', 'Vent moyen / rafales', 'cep-snow-wind ' + windForceClass(gustDisplay));
                var snowWindValues = document.createElement('strong');
                snowWindValues.textContent = (finite(windDisplay) ? formatNumber(windDisplay, 0) : '—') + ' / ' + (finite(gustDisplay) ? formatNumber(gustDisplay, 0) : '—') + ' km/h';
                snowWindCell.appendChild(snowWindValues);
                var snowDirectionDegrees = value(values, 'wind_direction_deg', 5);
                var snowDirection = windDirection(snowDirectionDegrees);
                if (snowDirection) {
                    var snowDirectionBadge = document.createElement('span');
                    snowDirectionBadge.className = 'cep-direction ' + windForceClass(gustDisplay);
                    snowDirectionBadge.title = 'Vent de ' + snowDirection + ' • ' + formatNumber(snowDirectionDegrees, 0) + '°';
                    var snowArrow = textSpan('➜', 'cep-wind-arrow');
                    snowArrow.style.transform = 'rotate(' + ((Number(snowDirectionDegrees) + 180) % 360) + 'deg)';
                    snowDirectionBadge.appendChild(snowArrow);
                    snowDirectionBadge.appendChild(textSpan(snowDirection, 'cep-wind-label'));
                    snowWindCell.appendChild(snowDirectionBadge);
                }
                snowRow.appendChild(snowWindCell);
                appendNumber(snowRow, 'Cumul neige fraîche', value(values, 'snow_depth_cm'), 1, ' cm');

                var snowDetailsCell = createCell('td', 'Détails', 'cep-details-cell cep-snow-details-cell');
                var snowDetailsButton = document.createElement('button');
                snowDetailsButton.type = 'button';
                snowDetailsButton.className = 'cep-details-button';
                snowDetailsButton.textContent = 'Afficher';
                snowDetailsButton.setAttribute('aria-expanded', 'false');
                snowDetailsCell.appendChild(snowDetailsButton);

                var snowAdvanced = document.createElement('div');
                snowAdvanced.className = 'cep-snow-profile cep-details-inline';
                snowAdvanced.hidden = true;

                function appendProfileSection(titleText, items) {
                    var section = document.createElement('section');
                    section.className = 'cep-profile-section';
                    section.appendChild(textSpan(titleText, 'cep-profile-title'));
                    var list = document.createElement('div');
                    list.className = 'cep-profile-list';
                    items.forEach(function (item) {
                        var profileItem = document.createElement('div');
                        profileItem.className = 'cep-profile-item';
                        profileItem.appendChild(textSpan(item[0], 'cep-profile-label'));
                        profileItem.appendChild(textSpan(finite(item[1]) ? formatNumber(item[1], item[2]) + item[3] : '—', 'cep-profile-value'));
                        list.appendChild(profileItem);
                    });
                    section.appendChild(list);
                    snowAdvanced.appendChild(section);
                }

                appendProfileSection('Sorties et diagnostics CEP', [
                    ['Température à 2 m', temp, 0, ' °C'],
                    ['Point de rosée', value(values, 'dewpoint_c'), 1, ' °C'],
                    ['Neige cumulée depuis le run', value(values, 'snowfall_total_mm'), 1, ' mm'],
                    ['Précipitations cumulées', value(values, 'precipitation_total_mm'), 1, ' mm'],
                    ['Réflectivité maximale', value(values, 'reflectivity_dbz'), 0, ' dBZ'],
                    ['Pression au sol', value(values, 'pressure_surface_hpa'), 0, ' hPa'],
                    ['Pression mer estimée', value(values, 'pressure_hpa'), 0, ' hPa']
                ]);

                snowDetailsCell.appendChild(snowAdvanced);
                snowRow.appendChild(snowDetailsCell);
                snowBody.appendChild(snowRow);

                snowDetailsButton.addEventListener('click', function () {
                    var open = snowAdvanced.hidden;
                    snowAdvanced.hidden = !open;
                    snowDetailsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
                    snowDetailsButton.textContent = open ? 'Masquer' : 'Afficher';
                    window.requestAnimationFrame(updateSnowTopScroll);
                });
            });

            if (stormSummary) {
                stormSummary.classList.toggle('cep-storm-summary-warning', !hasStormColumns);
                if (!hasStormColumns) {
                    stormSummary.textContent = 'Le run publié utilise encore l’ancien format : relancez le workflow GitHub après avoir remplacé les scripts pour activer le tableau Orages.';
                } else if (maxThunderRisk === null) {
                    stormSummary.textContent = 'Diagnostics orageux présents, mais aucune valeur exploitable sur les échéances affichées.';
                } else {
                    var maxRisk = THUNDER_RISKS[maxThunderRisk] || THUNDER_RISKS[0];
                    stormSummary.textContent = 'Risque orageux maximal sur les ' + forecasts.length + ' prochaines échéances : ' + maxRisk.icon + ' ' + maxRisk.label + ' • diagnostic indicatif croisant MUCAPE, précipitations actives, humidité et signaux convectifs ; la MUCAPE seule ne déclenche plus un risque.';
                }
            }
            if (snowSummary) {
                snowSummary.classList.toggle('cep-snow-summary-warning', !hasSnowColumns);
                if (!hasSnowColumns) {
                    snowSummary.textContent = 'Le run publié utilise encore l’ancien format : relancez le workflow GitHub pour activer le tableau Neige.';
                } else if (maxSnowRisk === null) {
                    snowSummary.textContent = 'Diagnostic neige présent, mais aucune valeur exploitable sur les échéances affichées.';
                } else {
                    var maxSnow = SNOW_RISKS[maxSnowRisk] || SNOW_RISKS[0];
                    snowSummary.textContent = 'Risque de neige maximal sur les ' + forecasts.length + ' prochaines échéances : ' + maxSnow.icon + ' ' + maxSnow.label + ' • cumul neige CEP/IFS.';
                }
            }

            var cityName = commune[1];
            var point = Array.isArray(departmentData.points) ? departmentData.points[pointId] : null;
            var altitude = point && finite(point[3]) ? Number(point[3]) : null;
            var postal = Array.isArray(commune[2]) && commune[2].length ? commune[2][0] : '';
            title.textContent = titlePrefix + ' — ' + cityName;
            if (altitudeLine) {
                altitudeLine.textContent = finite(altitude)
                    ? 'Altitude de ' + cityName + ' : ≈ ' + formatNumber(altitude, 0) + ' m (point de grille CEP)'
                    : 'Altitude de ' + cityName + ' : — (relancez le workflow GitHub CEP)';
                altitudeLine.classList.toggle('cep-altitude-missing', !finite(altitude));
            }
            selectedMapFocus = {
                latitude: Number(commune[4]),
                longitude: Number(commune[5]),
                label: cityName + (postal ? ' (' + postal + ')' : ''),
                // L'IFS 0,25° a une maille d'environ 28 km : un zoom x6
                // montre une région sans agrandir artificiellement 2 ou 3 mailles.
                scale: 6
            };
            var mapApp = app.querySelector('[data-cepm-app]');
            if (mapApp) {
                window.requestAnimationFrame(function () {
                    mapApp.dispatchEvent(new CustomEvent('cepm:focus-location', {
                        detail: selectedMapFocus
                    }));
                });
            }
            input.value = cityName;
            app.dataset.cityCode = commune[0];
            app.dataset.cityDepartment = departmentData.department;
            setStatus('Prévisions affichées pour ' + cityName + (postal ? ' (' + postal + ')' : '') + '.', false);

            if (chartTitleTemperature) { chartTitleTemperature.textContent = 'Diagramme températures (°C) pour la ville de ' + cityName; }
            if (chartTitlePressure) { chartTitlePressure.textContent = 'Diagramme pression ramenée au niveau de la mer (hPa) pour la ville de ' + cityName; }
            if (chartTitleRain) { chartTitleRain.textContent = 'Diagramme précipitations (mm) pour la ville de ' + cityName; }
            if (chartTitleWind) { chartTitleWind.textContent = 'Diagramme rafales et vent moyen pour la ville de ' + cityName; }
            if (rainTotal) { rainTotal.textContent = 'Précipitations cumulées : ' + formatNumber(cumulativeRain, 1) + ' mm'; }
            var chartMeta = {
                dayKeys: chartDayKeys,
                dayTokens: chartDayTokens,
                dayLabels: chartDayLabels,
                hourLabels: chartHourLabels
            };
            renderLineChart(chartTemperature, chartLabels, [{ label: 'Température', values: chartTemps, className: 'cep-series-temperature' }], {
                decimals: 0,
                unit: '°C',
                fillArea: false,
                metricMode: 'temperature',
                meta: chartMeta,
                showExtrema: false,
                showPoints: false,
                targetTicks: 6,
                paddingSteps: 1,
                ariaLabel: 'Températures prévues pour ' + cityName
            });
            renderLineChart(chartPressure, chartLabels, [{ label: 'Pression', values: chartPressures, className: 'cep-series-pressure' }], {
                decimals: 0,
                unit: 'hPa',
                fillArea: false,
                metricMode: 'pressure',
                meta: chartMeta,
                showExtrema: false,
                showPoints: false,
                targetTicks: 6,
                paddingSteps: 1,
                ariaLabel: 'Pression au niveau de la mer prévue pour ' + cityName
            });
            renderRainChart(chartRain, chartLabels, chartRainValues, chartRainCumulative, { meta: chartMeta, targetTicks: 6 });
            renderLineChart(chartWind, chartLabels, [
                { label: 'Vent moyen', values: chartWindValues, className: 'cep-series-wind' },
                { label: 'Rafales', values: chartGustValues, className: 'cep-series-gust' }
            ], {
                decimals: 0,
                unit: 'km/h',
                forceZero: true,
                bandBetween: false,
                metricMode: 'wind',
                meta: chartMeta,
                showExtrema: false,
                showPoints: false,
                targetTicks: 6,
                paddingSteps: 1,
                ariaLabel: 'Vent moyen et rafales prévus pour ' + cityName
            });
            window.requestAnimationFrame(updateStormTopScroll);
            window.requestAnimationFrame(updateSnowTopScroll);
        }

        function selectCommune(candidate) {
            closeResults();
            input.value = candidate.nom;
            setStatus('Chargement des prévisions pour ' + candidate.nom + '…', false);
            showTableMessage('Chargement des prévisions…', false);
            loadDepartment(candidate.codeDepartement)
                .then(function (departmentData) {
                    var commune = departmentData.communes.find(function (item) {
                        return item[0] === candidate.code;
                    });
                    if (!commune) {
                        throw new Error('Commune absente du catalogue CEP');
                    }
                    renderForecast(departmentData, commune);
                })
                .catch(function (error) {
                    showTableMessage('Prévisions indisponibles : ' + error.message, true);
                    setStatus(error.message, true);
                });
        }

        function displaySearchResults(candidates) {
            results.replaceChildren();
            resultButtons = [];
            activeResult = -1;
            if (!candidates.length) {
                closeResults();
                setStatus('Aucune commune métropolitaine trouvée.', true);
                return;
            }

            candidates.forEach(function (candidate, position) {
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'cep-search-result';
                button.id = input.id + '-option-' + position;
                button.setAttribute('role', 'option');
                button.setAttribute('aria-selected', 'false');

                var name = textSpan(candidate.nom, 'cep-result-name');
                var postals = Array.isArray(candidate.codesPostaux)
                    ? candidate.codesPostaux.join(', ')
                    : '';
                var details = textSpan(
                    (postals ? postals + ' • ' : '') +
                    'département ' + candidate.codeDepartement,
                    'cep-result-details'
                );
                button.appendChild(name);
                button.appendChild(details);
                button.addEventListener('click', function () {
                    selectCommune(candidate);
                });
                results.appendChild(button);
                resultButtons.push(button);
            });
            results.hidden = false;
            input.setAttribute('aria-expanded', 'true');
            setStatus(candidates.length + ' commune(s) proposée(s).', false);
        }

        function searchCommunes(query) {
            if (!indexData) {
                return;
            }
            if (searchController) {
                searchController.abort();
            }
            searchController = new AbortController();
            var parameters = new URLSearchParams({
                fields: 'nom,code,codesPostaux,codeDepartement,population',
                format: 'json',
                boost: 'population',
                limit: '12'
            });
            if (/^\d{5}$/.test(query)) {
                parameters.set('codePostal', query);
            } else {
                parameters.set('nom', query);
            }
            setStatus('Recherche des communes…', false);
            fetchJson(COMMUNES_API + '?' + parameters.toString(), {
                signal: searchController.signal,
                cache: 'default'
            })
                .then(function (payload) {
                    var candidates = Array.isArray(payload) ? payload : [];
                    candidates = candidates.filter(function (candidate) {
                        var code = String(candidate.codeDepartement || '').toUpperCase();
                        return Boolean(indexData.departments[code]);
                    });
                    displaySearchResults(candidates.slice(0, 12));
                })
                .catch(function (error) {
                    if (error.name === 'AbortError') {
                        return;
                    }
                    closeResults();
                    setStatus('Recherche momentanément indisponible.', true);
                });
        }

        function detectCurrentCommune() {
            if (!locateButton) { return; }
            if (!navigator.geolocation) {
                setStatus('La géolocalisation n’est pas disponible dans ce navigateur.', true);
                return;
            }
            locateButton.disabled = true;
            locateButton.classList.add('is-loading');
            locateButton.textContent = '📍 Localisation…';
            setStatus('Recherche de votre position…', false);

            navigator.geolocation.getCurrentPosition(function (position) {
                var parameters = new URLSearchParams({
                    lat: String(position.coords.latitude),
                    lon: String(position.coords.longitude),
                    fields: 'nom,code,codesPostaux,codeDepartement,population',
                    format: 'json'
                });
                fetchJson(COMMUNES_API + '?' + parameters.toString(), { cache: 'default' })
                    .then(function (payload) {
                        var candidates = Array.isArray(payload) ? payload : (payload ? [payload] : []);
                        var candidate = candidates.find(function (item) {
                            var department = String(item.codeDepartement || '').toUpperCase();
                            return indexData && indexData.departments && indexData.departments[department];
                        });
                        if (!candidate) {
                            throw new Error('Votre position ne correspond pas à une commune couverte.');
                        }
                        selectCommune(candidate);
                        setStatus('Ville détectée : ' + candidate.nom + '.', false);
                    })
                    .catch(function (error) {
                        setStatus('Impossible de détecter votre commune : ' + error.message, true);
                    })
                    .finally(function () {
                        locateButton.disabled = false;
                        locateButton.classList.remove('is-loading');
                        locateButton.textContent = '📍 Détecter ma ville';
                    });
            }, function (error) {
                var message = 'Localisation refusée ou indisponible.';
                if (error && error.code === 1) { message = 'Autorisation de localisation refusée.'; }
                else if (error && error.code === 2) { message = 'Position actuellement indisponible.'; }
                else if (error && error.code === 3) { message = 'La localisation a pris trop de temps.'; }
                setStatus(message, true);
                locateButton.disabled = false;
                locateButton.classList.remove('is-loading');
                locateButton.textContent = '📍 Détecter ma ville';
            }, {
                enableHighAccuracy: false,
                timeout: 12000,
                maximumAge: 300000
            });
        }

        if (locateButton) {
            locateButton.addEventListener('click', detectCurrentCommune);
        }

        input.addEventListener('input', function () {
            window.clearTimeout(debounceTimer);
            var query = input.value.trim();
            if (query.length < 2) {
                closeResults();
                setStatus('Saisissez au moins deux lettres ou un code postal.', false);
                return;
            }
            if (/^\d+$/.test(query) && query.length < 5) {
                closeResults();
                setStatus('Saisissez les cinq chiffres du code postal.', false);
                return;
            }
            debounceTimer = window.setTimeout(function () {
                searchCommunes(query);
            }, 280);
        });

        input.addEventListener('keydown', function (event) {
            if (results.hidden || !resultButtons.length) {
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveResult(activeResult + 1);
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveResult(activeResult <= 0 ? 0 : activeResult - 1);
            } else if (event.key === 'Enter' && activeResult >= 0) {
                event.preventDefault();
                resultButtons[activeResult].click();
            } else if (event.key === 'Escape') {
                closeResults();
            }
        });

        document.addEventListener('click', function (event) {
            if (!app.contains(event.target)) {
                closeResults();
            }
        });

        if (!baseUrl) {
            showTableMessage('Adresse des données CEP non configurée.', true);
            return;
        }
        loadIndex()
            .then(function () {
                return loadDepartment(defaultDepartment);
            })
            .then(function (departmentData) {
                var commune = departmentData.communes.find(function (item) {
                    return item[0] === defaultCode;
                });
                if (!commune) {
                    throw new Error('Commune initiale absente du catalogue');
                }
                renderForecast(departmentData, commune);
            })
            .catch(function (error) {
                showTableMessage(
                    'Les données nationales ne sont pas encore disponibles : ' + error.message,
                    true
                );
                setStatus('Données nationales indisponibles.', true);
            });
    }

    whenReady(function () {
        document.querySelectorAll('[data-cep-app]').forEach(initApp);
    });
}());
