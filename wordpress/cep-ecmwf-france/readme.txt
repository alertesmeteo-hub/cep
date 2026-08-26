=== CEP / ECMWF France ===
Contributors: alertesmeteo
Tags: meteo, cep, ecmwf, ifs, carte, previsions, avada
Requires at least: 5.8
Requires PHP: 7.4
Stable tag: 1.3.0
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

= 1.3.0 =
* Zonages météo rendus par interpolation bicubique puis isovaleurs remplies.
* Rééchantillonnage continu de la grille mondiale en longitude.
* Zoom automatique ramené de 3 200 % à 600 %, adapté à la maille IFS de 28 km.
* Altitudes converties correctement du géopotentiel en mètres après reconstruction de la branche data.

= 1.2.0 =
* Limites départementales précises issues des tracés IGN, avec repli automatique sur les limites calculées.
* Module élargi à 1 480 px et tableau général plus aéré sur grand écran.
* Correction du maintien des surcouches de vent lors d'un zoom important.
* Libellés de précipitations corrigés : l'IFS fournit ici des cumuls entre deux échéances (3 h puis 6 h), et non des cumuls horaires.

= 1.1.0 =
* Rendu en plages colorées lissées sur toutes les cartes CEP.
* Isolignes de vitesse et flèches directionnelles sur les cartes Vent moyen et Rafales.

= 1.0.0 =
* Première version indépendante CEP/ECMWF IFS 0,25°.
* Pipeline GitHub Actions jusqu'à +240 h et publication sur la branche data.
* Cartes, recherche, tableaux, graphiques et outils interactifs dans un shortcode unique.
