=== CEP / ECMWF France ===
Contributors: alertesmeteo
Tags: meteo, cep, ecmwf, ifs, carte, previsions, avada
Requires at least: 5.8
Requires PHP: 7.4
Stable tag: 1.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Cartes interactives et prévisions du modèle déterministe CEP/ECMWF IFS pour 34 746 communes françaises.

== Description ==

Le shortcode [cep_meteo] affiche dans un seul module :

* une carte CEP/IFS interactive avec zoom, animation et valeur au survol ;
* une recherche par ville ou code postal et la géolocalisation ;
* les prévisions générales jusqu'à +240 h ;
* quatre graphiques et des diagnostics orage/neige ;
* les outils Zoom interactif, capture PNG, épinglage et diagramme au clic.

Les données proviennent directement d'ECMWF Open Data, modèle IFS déterministe à 0,25°.

== Installation ==

1. Téléversez le ZIP dans Extensions > Ajouter une extension.
2. Activez CEP / ECMWF France.
3. Vérifiez l'URL dans Réglages > CEP / ECMWF.
4. Insérez [cep_meteo] dans un bloc Avada.

Exemple : [cep_meteo code="75056" departement="75" ville="Paris" heures="240"]

== Changelog ==

= 1.1.0 =
* Rendu en plages colorées lissées sur toutes les cartes CEP.
* Isolignes de vitesse et flèches directionnelles sur les cartes Vent moyen et Rafales.

= 1.0.0 =
* Première version indépendante CEP/ECMWF IFS 0,25°.
* Pipeline GitHub Actions jusqu'à +240 h et publication sur la branche data.
* Cartes, recherche, tableaux, graphiques et outils interactifs dans un shortcode unique.
