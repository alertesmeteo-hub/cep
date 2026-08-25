<?php
/**
 * Plugin Name: CEP / ECMWF France — Tableaux et cartes
 * Plugin URI: https://github.com/alertesmeteo-hub/cep
 * Description: Cartes interactives et prévisions du modèle déterministe CEP/ECMWF IFS pour la France métropolitaine et la Corse.
 * Version: 1.0.0
 * Author: Alertes Météo Hub
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 */

if (!defined('ABSPATH')) {
    exit;
}

define('CEP_VERSION', '1.0.0');
define('CEP_RELEASE_DATE', '25/08/2026');
define('CEP_OPTION_BASE_URL', 'cep_national_data_base_url');
define(
    'CEP_DEFAULT_BASE_URL',
    'https://raw.githubusercontent.com/alertesmeteo-hub/cep/data'
);

add_action('wp_enqueue_scripts', 'cep_register_assets');
add_action('admin_init', 'cep_register_settings');
add_action('admin_menu', 'cep_add_settings_page');
add_shortcode('cep_meteo', 'cep_render_shortcode');
add_filter('plugin_action_links_' . plugin_basename(__FILE__), 'cep_plugin_action_links');

function cep_plugin_action_links($links) {
    $settings_link = sprintf(
        '<a href="%s">%s</a>',
        esc_url(admin_url('options-general.php?page=cep-ecmwf')),
        esc_html__('Réglages', 'cep-ecmwf-france')
    );
    array_unshift($links, $settings_link);

    $help_link = sprintf(
        '<a href="%s">%s</a>',
        esc_url(admin_url('options-general.php?page=cep-ecmwf')),
        esc_html__('Shortcodes / Aide', 'cep-ecmwf-france')
    );
    array_unshift($links, $help_link);

    return $links;
}

function cep_register_assets() {
    wp_register_style(
        'cep-table',
        plugin_dir_url(__FILE__) . 'assets/cep-meteo.css',
        array(),
        CEP_VERSION
    );
    wp_register_script(
        'cep-table',
        plugin_dir_url(__FILE__) . 'assets/cep-meteo.js',
        array(),
        CEP_VERSION,
        true
    );
    wp_register_style(
        'cep-map',
        plugin_dir_url(__FILE__) . 'assets/cep-map.css',
        array('cep-table'),
        CEP_VERSION
    );
    wp_register_script(
        'cep-map',
        plugin_dir_url(__FILE__) . 'assets/cep-map.js',
        array(),
        CEP_VERSION,
        true
    );
}

function cep_register_settings() {
    register_setting(
        'cep_settings',
        CEP_OPTION_BASE_URL,
        array(
            'type' => 'string',
            'sanitize_callback' => 'esc_url_raw',
            'default' => CEP_DEFAULT_BASE_URL,
        )
    );

    add_settings_section(
        'cep_main_section',
        'Source des données nationales',
        '__return_false',
        'cep-ecmwf'
    );

    add_settings_field(
        'cep_data_base_url_field',
        'Adresse du dossier de données',
        'cep_render_url_field',
        'cep-ecmwf',
        'cep_main_section'
    );
}

function cep_render_url_field() {
    $value = get_option(CEP_OPTION_BASE_URL, CEP_DEFAULT_BASE_URL);
    printf(
        '<input type="url" class="regular-text code" name="%1$s" value="%2$s" autocomplete="off">',
        esc_attr(CEP_OPTION_BASE_URL),
        esc_attr($value)
    );
    echo '<p class="description">Conservez l’adresse proposée : elle pointe vers la branche nationale « data » du dépôt.</p>';
}

function cep_add_settings_page() {
    add_options_page(
        'Tableau CEP / ECMWF France',
        'CEP / ECMWF',
        'manage_options',
        'cep-ecmwf',
        'cep_render_settings_page'
    );
}

function cep_render_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }
    ?>
    <div class="wrap">
        <h1>CEP / ECMWF France</h1>
        <form action="options.php" method="post">
            <?php
            settings_fields('cep_settings');
            do_settings_sections('cep-ecmwf');
            submit_button();
            ?>
        </form>
        <p><strong>Version du module : <?php echo esc_html(CEP_VERSION); ?> (<?php echo esc_html(CEP_RELEASE_DATE); ?>)</strong></p>
        <h2>Shortcode unique</h2>
        <p><code>[cep_meteo]</code> : cartes interactives, prévisions générales, orages, neige et graphiques.</p>
        <p><code>[cep_meteo code="75056" departement="75" ville="Paris" heures="240"]</code></p>
        <p><code>[cep_meteo code="66136" departement="66" ville="Perpignan" selecteur="non"]</code> : une seule ville, sans recherche.</p>
        <p>Le visiteur peut ensuite rechercher n’importe quelle commune ou saisir un code postal.</p>
    </div>
    <?php
}

function cep_base_url() {
    $url = get_option(CEP_OPTION_BASE_URL, CEP_DEFAULT_BASE_URL);
    return untrailingslashit(apply_filters('cep_national_data_base_url', $url));
}

function cep_department_code($value) {
    $code = strtoupper(trim((string) $value));
    return preg_match('/^(?:\d{2}|2A|2B)$/', $code) ? $code : '66';
}

function cep_commune_code($value) {
    $code = strtoupper(trim((string) $value));
    return preg_match('/^[0-9A-Z]{5}$/', $code) ? $code : '66136';
}

function cep_unique_identifier() {
    if (function_exists('wp_unique_id')) {
        return wp_unique_id('cep-city-');
    }
    return 'cep-city-' . wp_rand(1000, 999999);
}

function cep_map_variable($value) {
    $variable = strtolower(trim(sanitize_key((string) $value)));
    $allowed = array(
        'temperature',
        'temperature_ressentie',
        'point_rosee',
        'humidex',
        'pluie_1h',
        'pluie_cumul',
        'neige',
        'neige_au_sol',
        'equivalent_eau_neige',
        'graupel',
        'vent',
        'rafales',
        'pression',
        'pression_surface',
        'nebulosite',
        'nuages_bas',
        'nuages_moyens',
        'nuages_eleves',
        'humidite',
        'mucape',
        'reflectivite',
        'altitude',
    );
    return in_array($variable, $allowed, true) ? $variable : 'temperature';
}

function cep_render_map_shortcode($atts) {
    $atts = shortcode_atts(
        array(
            'variable' => 'temperature',
            'hauteur' => '700',
            'titre' => 'Cartes CEP France',
            'animation' => 'oui',
        ),
        $atts,
        'cep_meteo'
    );

    $variable = cep_map_variable($atts['variable']);
    $height = max(440, min(900, absint($atts['hauteur'])));
    $title = trim(sanitize_text_field($atts['titre']));
    if ($title === '') {
        $title = 'Cartes CEP France';
    }
    $animation_value = strtolower(trim(sanitize_text_field($atts['animation'])));
    $animation = !in_array($animation_value, array('non', '0', 'false', 'off'), true);
    $map_id = function_exists('wp_unique_id')
        ? wp_unique_id('cep-map-')
        : 'cep-map-' . wp_rand(1000, 999999);

    wp_enqueue_style('cep-map');
    wp_enqueue_script('cep-map');

    ob_start();
    ?>
    <section
        id="<?php echo esc_attr($map_id); ?>"
        class="cep-card cepm-card"
        data-cepm-app
        data-base-url="<?php echo esc_url(cep_base_url()); ?>"
        data-variable="<?php echo esc_attr($variable); ?>"
        data-timezone="<?php echo esc_attr(wp_timezone_string()); ?>"
        data-animation="<?php echo $animation ? '1' : '0'; ?>"
        data-module-version="<?php echo esc_attr(CEP_VERSION); ?>"
        style="--cepm-height: <?php echo esc_attr($height); ?>px"
    >
        <header class="cep-header cepm-header">
            <div>
                <p class="cep-kicker">MODÈLE HAUTE RÉSOLUTION • ÉCHÉANCES HORAIRES</p>
                <h2><?php echo esc_html($title); ?></h2>
                <p class="cep-meta" data-cepm-run>Chargement du dernier run CEP…</p>
            </div>
            <div class="cep-badge">CEP<br><strong>0,25°</strong></div>
        </header>

        <div class="cepm-toolbar">
            <div class="cepm-field cepm-layer-picker">
                <span>Paramètre</span>
                <button
                    type="button"
                    class="cepm-layer-trigger"
                    data-cepm-menu-toggle
                    aria-expanded="false"
                    aria-controls="<?php echo esc_attr($map_id . '-layers'); ?>"
                >
                    <span data-cepm-current-layer>Température à 2 m</span>
                    <span class="cepm-layer-chevron" aria-hidden="true">⌄</span>
                </button>
            </div>
            <div class="cepm-tools" aria-label="Outils de la carte">
                <button
                    type="button"
                    class="cepm-tool-toggle"
                    data-cepm-tool="zoom"
                    aria-pressed="false"
                    title="Afficher les outils de capture et d’épinglage"
                >🔍 Zoom interactif</button>
                <button
                    type="button"
                    class="cepm-tool-toggle"
                    data-cepm-tool="diagram"
                    aria-pressed="false"
                    title="Cliquer sur la carte pour afficher le diagramme d’un point"
                >📈 Diagramme</button>
            </div>
            <div class="cepm-time-controls" aria-label="Navigation dans les échéances">
                <button type="button" data-cepm-previous title="Échéance précédente" aria-label="Échéance précédente">◀</button>
                <button type="button" data-cepm-play title="Lancer l’animation" aria-label="Lancer l’animation">▶</button>
                <button type="button" data-cepm-next title="Échéance suivante" aria-label="Échéance suivante">▶</button>
            </div>
            <div class="cepm-validity">
                <span>Prévision valable</span>
                <strong data-cepm-validity>—</strong>
                <small data-cepm-lead>—</small>
            </div>
        </div>

        <p class="cepm-tool-hint" data-cepm-tool-hint hidden></p>

        <div
            id="<?php echo esc_attr($map_id . '-layers'); ?>"
            class="cepm-layer-menu"
            data-cepm-layer-menu
            hidden
        >
            <div class="cepm-layer-menu-head">
                <div>
                    <strong>Choisir une carte CEP</strong>
                    <small>Paramètres disponibles dans la production ouverte ECMWF IFS</small>
                </div>
                <button type="button" data-cepm-menu-close aria-label="Réduire le menu">×</button>
            </div>
            <div class="cepm-layer-grid" data-cepm-layer-grid></div>
        </div>

        <p class="cep-stale" data-cepm-stale role="status" hidden>
            Attention : la dernière production disponible a plus de 8 heures.
        </p>

        <div class="cepm-viewport" data-cepm-viewport role="img" aria-label="Carte météo CEP interactive">
            <div class="cepm-scene" data-cepm-scene>
                <canvas class="cepm-weather-canvas" data-cepm-weather aria-hidden="true"></canvas>
                <canvas class="cepm-vector-canvas" data-cepm-vectors aria-hidden="true"></canvas>
            </div>
            <canvas class="cepm-label-canvas" data-cepm-labels aria-hidden="true"></canvas>
            <div class="cepm-probe" data-cepm-probe hidden>
                <strong data-cepm-probe-value>—</strong>
                <span data-cepm-probe-label>Valeur CEP</span>
            </div>
            <div class="cepm-map-titlebar">
                <strong data-cepm-map-title>Carte CEP</strong>
                <span data-cepm-map-run>Run CEP —</span>
            </div>
            <div class="cepm-map-date" data-cepm-map-date>Échéance —</div>
            <div class="cepm-map-buttons" aria-label="Commandes de zoom">
                <span class="cepm-zoom-level" data-cepm-zoom-level>100 %</span>
                <button type="button" data-cepm-zoom-in title="Agrandir" aria-label="Agrandir">+</button>
                <button type="button" data-cepm-zoom-out title="Réduire" aria-label="Réduire">−</button>
                <button type="button" data-cepm-reset title="Recentrer" aria-label="Recentrer">⌂</button>
                <button type="button" data-cepm-fullscreen title="Plein écran" aria-label="Plein écran">⛶</button>
            </div>
            <div class="cepm-advanced-tools" data-cepm-advanced-tools hidden aria-label="Outils avancés">
                <button type="button" data-cepm-capture title="Capturer l’image affichée" aria-label="Capturer l’image affichée">📷 Capture PNG</button>
                <button type="button" data-cepm-pin title="Épingler la valeur au clic" aria-label="Épingler la valeur au clic" aria-pressed="false">📌 Figer la valeur</button>
            </div>
            <div class="cepm-diagram-popup" data-cepm-diagram-popup hidden>
                <header>
                    <strong data-cepm-diagram-title>—</strong>
                    <button type="button" data-cepm-diagram-close aria-label="Fermer le diagramme">×</button>
                </header>
                <div class="cepm-diagram-body" data-cepm-diagram-body>
                    <p class="cepm-diagram-status" data-cepm-diagram-status>Chargement…</p>
                </div>
            </div>
            <div class="cepm-legend" data-cepm-legend aria-label="Légende de la carte"></div>
            <a class="cepm-map-brand" href="https://www.alertes-meteo.com/" target="_blank" rel="noopener noreferrer">
                www.alertes-meteo.com • Module v<?php echo esc_html(CEP_VERSION); ?> (<?php echo esc_html(CEP_RELEASE_DATE); ?>)
            </a>
            <div class="cepm-loading" data-cepm-loading role="status">Chargement de la carte…</div>
            <div class="cepm-error" data-cepm-error role="alert" hidden></div>
        </div>

        <div class="cepm-timeline">
            <input data-cepm-slider type="range" min="0" max="0" value="0" step="1" aria-label="Échéance de prévision">
            <div class="cepm-timeline-labels"><span>Run</span><span>Échéance maximale</span></div>
        </div>

        <footer class="cep-footer">
            <span data-cepm-generated>Mise à jour en cours de lecture…</span>
            <span>
                Données météo directes :
                <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener noreferrer">IFS 0,25° — ECMWF Open Data</a>
                • <a href="https://www.alertes-meteo.com/" target="_blank" rel="noopener noreferrer">www.alertes-meteo.com</a>
                • Module cartes v<?php echo esc_html(CEP_VERSION); ?> (<?php echo esc_html(CEP_RELEASE_DATE); ?>)
            </span>
        </footer>

        <noscript>
            <p class="cep-message cep-error">JavaScript doit être activé pour afficher les cartes.</p>
        </noscript>
    </section>
    <?php
    return ob_get_clean();
}

function cep_render_shortcode($atts) {
    $atts = shortcode_atts(
        array(
            'ville' => 'Perpignan',
            'code' => '66136',
            'departement' => '66',
            'heures' => '240',
            'titre' => '',
            'selecteur' => 'oui',
        ),
        $atts,
        'cep_meteo'
    );

    $hours = max(3, min(240, absint($atts['heures'])));
    $city_name = sanitize_text_field($atts['ville']);
    if ($city_name === '') {
        $city_name = 'Perpignan';
    }
    $city_code = cep_commune_code($atts['code']);
    $department = cep_department_code($atts['departement']);
    $title_prefix = trim(sanitize_text_field($atts['titre']));
    if ($title_prefix === '') {
        $title_prefix = 'Prévisions CEP';
    }
    $selector_value = strtolower(trim(sanitize_text_field($atts['selecteur'])));
    $show_selector = !in_array($selector_value, array('non', '0', 'false', 'off'), true);

    $input_id = cep_unique_identifier();
    $results_id = $input_id . '-results';
    $status_id = $input_id . '-status';

    wp_enqueue_style('cep-table');
    wp_enqueue_script('cep-table');
    wp_enqueue_style('cep-map');
    wp_enqueue_script('cep-map');

    ob_start();
    ?>
    <section
        class="cep-card cep-national"
        data-cep-app
        data-base-url="<?php echo esc_url(cep_base_url()); ?>"
        data-default-code="<?php echo esc_attr($city_code); ?>"
        data-default-department="<?php echo esc_attr($department); ?>"
        data-default-name="<?php echo esc_attr($city_name); ?>"
        data-hours="<?php echo esc_attr($hours); ?>"
        data-timezone="<?php echo esc_attr(wp_timezone_string()); ?>"
        data-title-prefix="<?php echo esc_attr($title_prefix); ?>"
        data-selector="<?php echo $show_selector ? '1' : '0'; ?>"
    >
        <header class="cep-header">
            <div>
                <p class="cep-kicker">MODÈLE HAUTE RÉSOLUTION • FRANCE MÉTROPOLITAINE</p>
                <h2 data-cep-title><?php echo esc_html($title_prefix . ' — ' . $city_name); ?></h2>
                <p class="cep-city-altitude" data-cep-altitude>Altitude de <?php echo esc_html($city_name); ?> : chargement…</p>
                <p class="cep-meta" data-cep-meta>Chargement du dernier run CEP…</p>
            </div>
            <div class="cep-badge">CEP<br><strong>0,25°</strong></div>
        </header>

        <div class="cep-toolbar" <?php if (!$show_selector) : ?>hidden<?php endif; ?>>
            <div class="cep-search">
                <label for="<?php echo esc_attr($input_id); ?>">Choisissez votre commune</label>
                <div class="cep-search-control">
                    <span class="cep-search-icon" aria-hidden="true">⌕</span>
                    <input
                        id="<?php echo esc_attr($input_id); ?>"
                        class="cep-city-input"
                        type="search"
                        value="<?php echo esc_attr($city_name); ?>"
                        placeholder="Nom de commune ou code postal"
                        autocomplete="off"
                        spellcheck="false"
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded="false"
                        aria-controls="<?php echo esc_attr($results_id); ?>"
                        aria-describedby="<?php echo esc_attr($status_id); ?>"
                    >
                </div>
                <button type="button" class="cep-locate-button" data-cep-locate>📍 Détecter ma ville</button>
                <div
                    id="<?php echo esc_attr($results_id); ?>"
                    class="cep-search-results"
                    role="listbox"
                    hidden
                ></div>
                <p
                    id="<?php echo esc_attr($status_id); ?>"
                    class="cep-search-status"
                    role="status"
                    aria-live="polite"
                >Saisissez au moins deux lettres ou un code postal.</p>
            </div>
            <div class="cep-coverage">
                <strong>34 746 communes</strong>
                <span>Métropole et Corse</span>
            </div>
        </div>

        <p class="cep-stale" data-cep-stale role="status" hidden>
            Attention : la dernière mise à jour disponible a plus de 8 heures.
        </p>

        <div class="cep-tabs" role="tablist" aria-label="Type de prévision CEP">
            <button
                type="button"
                class="cep-tab cep-tab-map is-active"
                role="tab"
                aria-selected="true"
                data-cep-tab="map"
            >🗺️ Cartes météo</button>
            <button
                type="button"
                class="cep-tab"
                role="tab"
                aria-selected="false"
                data-cep-tab="general"
            >🌤️ Prévisions générales</button>
            <button
                type="button"
                class="cep-tab cep-tab-storm"
                role="tab"
                aria-selected="false"
                data-cep-tab="storms"
            >⛈️ Prévisions orages</button>
            <button
                type="button"
                class="cep-tab cep-tab-snow"
                role="tab"
                aria-selected="false"
                data-cep-tab="snow"
            >❄️ Risque de neige</button>
        </div>

        <div class="cep-panel cep-map-panel" data-cep-panel="map">
            <?php
            echo cep_render_map_shortcode(
                array(
                    'variable' => 'temperature',
                    'hauteur' => '760',
                    'titre' => 'Cartes CEP / ECMWF IFS — résolution 0,25°',
                    'animation' => 'oui',
                )
            );
            ?>
        </div>

        <div class="cep-panel" data-cep-panel="general" hidden>
            <div class="cep-table-wrap cep-general-wrap" role="region" aria-label="Prévisions horaires générales" tabindex="0">
                <table class="cep-table">
                    <thead>
                        <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Heure</th>
                            <th scope="col">Temps</th>
                            <th scope="col">T°</th>
                            <th scope="col">Hum.</th>
                            <th scope="col">Pluie</th>
                            <th scope="col">Nuages</th>
                            <th scope="col">Vent</th>
                            <th scope="col">Rafales</th>
                            <th scope="col">Pression</th>
                        </tr>
                    </thead>
                    <tbody data-cep-body-general>
                        <tr>
                            <td colspan="10" class="cep-loading">Chargement des prévisions…</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <section class="cep-charts" data-cep-charts aria-label="Diagrammes CEP">
                <article class="cep-chart-card">
                    <h3 data-cep-chart-title-temperature>Diagramme températures (°C)</h3>
                    <div class="cep-chart" data-cep-chart-temperature></div>
                </article>
                <article class="cep-chart-card">
                    <h3 data-cep-chart-title-pressure>Diagramme pression ramenée au niveau de la mer (hPa)</h3>
                    <div class="cep-chart" data-cep-chart-pressure></div>
                </article>
                <article class="cep-chart-card">
                    <h3 data-cep-chart-title-rain>Diagramme précipitations (mm)</h3>
                    <p class="cep-chart-total" data-cep-rain-total>Précipitations cumulées : —</p>
                    <div class="cep-chart" data-cep-chart-rain></div>
                </article>
                <article class="cep-chart-card">
                    <h3 data-cep-chart-title-wind>Diagramme rafales et vent moyen</h3>
                    <div class="cep-chart" data-cep-chart-wind></div>
                </article>
            </section>
        </div>

        <div class="cep-panel" data-cep-panel="storms" hidden>
            <p class="cep-storm-summary" data-cep-storm-summary>
                Diagnostic convectif CEP/IFS : chargement…
            </p>
            <div class="cep-top-scroll" data-cep-top-scroll="storms" aria-label="Navigation horizontale du tableau orages" hidden><div></div></div>
            <div class="cep-table-wrap cep-storm-wrap" data-cep-scroll-wrap="storms" role="region" aria-label="Prévisions horaires d'orages" tabindex="0">
                <table class="cep-table cep-storm-table">
                    <thead>
                        <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Heure</th>
                            <th scope="col">Risque orage</th>
                            <th scope="col">MUCAPE</th>
                            <th scope="col">LCL estimé</th>
                            <th scope="col">Foudre</th>
                            <th scope="col">Grêle</th>
                            <th scope="col">Pluie conv.</th>
                            <th scope="col">Graupel</th>
                            <th scope="col">Pluie 1 h</th>
                            <th scope="col">Rafales</th>
                            <th scope="col">Type</th>
                            <th scope="col">Détails</th>
                        </tr>
                    </thead>
                    <tbody data-cep-body-storms>
                        <tr>
                            <td colspan="13" class="cep-loading">Chargement du diagnostic orageux…</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="cep-storm-note">
                <strong>Lecture expert :</strong> la MUCAPE et la réflectivité maximale sont des sorties directes CEP. Le risque, la foudre, la grêle et le type d’orage sont des diagnostics dérivés clairement signalés ; aucune valeur indisponible n’est inventée.
            </p>
        </div>

        <div class="cep-panel" data-cep-panel="snow" hidden>
            <p class="cep-snow-summary" data-cep-snow-summary>
                Diagnostic neige CEP/IFS : chargement…
            </p>
            <div class="cep-top-scroll" data-cep-top-scroll="snow" aria-label="Navigation horizontale du tableau neige" hidden><div></div></div>
            <div class="cep-table-wrap cep-snow-wrap" data-cep-scroll-wrap="snow" role="region" aria-label="Risque horaire de neige" tabindex="0">
                <table class="cep-table cep-snow-table">
                    <thead>
                        <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Heure</th>
                            <th scope="col">Risque neige</th>
                            <th scope="col">Phase</th>
                            <th scope="col">Neige 1 h</th>
                            <th scope="col">Neige 3 h</th>
                            <th scope="col">Neige 6 h</th>
                            <th scope="col">Tenue</th>
                            <th scope="col">Pres. hPa</th>
                            <th scope="col">Hum.</th>
                            <th scope="col">Vent moy. / raf.</th>
                            <th scope="col">Cumul neige fraîche</th>
                            <th scope="col">Détails</th>
                        </tr>
                    </thead>
                    <tbody data-cep-body-snow>
                        <tr>
                            <td colspan="13" class="cep-loading">Chargement du risque de neige…</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="cep-snow-note">
                <strong>Lecture neige :</strong> les cumuls de neige sont des sorties directes CEP. La neige fraîche et la tenue sont estimées à partir du cumul en eau, de la température à 2 m et de l’altitude du point de grille.
            </p>
        </div>

        <footer class="cep-footer">
            <span data-cep-generated>Mise à jour en cours de lecture…</span>
            <span>
                Données météo directes :
                <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener noreferrer">IFS 0,25° — ECMWF Open Data</a>
                • Recherche des communes :
                <a href="https://geo.api.gouv.fr/decoupage-administratif/communes" target="_blank" rel="noopener noreferrer">API officielle française</a>
                • <a href="https://www.alertes-meteo.com/" target="_blank" rel="noopener noreferrer">www.alertes-meteo.com</a>
            </span>
            <span class="cep-plugin-version">Module CEP v<?php echo esc_html(CEP_VERSION); ?> (<?php echo esc_html(CEP_RELEASE_DATE); ?>)</span>
        </footer>

        <noscript>
            <p class="cep-message cep-error">JavaScript doit être activé pour rechercher une commune.</p>
        </noscript>
    </section>
    <?php
    return ob_get_clean();
}
