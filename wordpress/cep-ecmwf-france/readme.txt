=== CEP / ECMWF France ===
Contributors: alertesmeteo
Tags: meteo, cep, ecmwf, ifs, carte, previsions, avada
Requires at least: 5.8
Requires PHP: 7.4
Stable tag: 1.5.2
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Cartes interactives et prévisions du modèle déterministe CEP/ECMWF IFS pour 34 746 communes françaises.

== Description ==

Le shortcode [cep_meteo] affiche dans un seul module :

* une carte CEP/IFS interactive avec zoom, animation et valeur au survol ;
* une recherche par ville ou code postal et la géolocalisation ;
* les prévisions générales jusqu'à +240 h ;
* quatre graphiques et des diagnostics orage/neige ;
* les outils Zoom interactif, copie d’image, téléchargement PNG et diagramme au clic.

Les données proviennent directement d'ECMWF Open Data, modèle IFS déterministe à 0,25°.

== Installation ==

1. Téléversez le ZIP dans Extensions > Ajouter une extension.
2. Activez CEP / ECMWF France.
3. Vérifiez l'URL dans Réglages > CEP / ECMWF.
4. Insérez [cep_meteo] dans un bloc Avada.

Exemple : [cep_meteo code="75056" departement="75" ville="Paris" heures="240"]

== Changelog ==

= 1.5.2 =
* En-tête compact, ville, bouton de détection et commune affichée sur une même ligne sur grand écran.
* Suppression du chevron du paramètre et bouton Replier/Déplier conservé en permanence à côté de la validité.
* Deux curseurs de période placés au-dessus de la carte pour les cumuls de pluie et les rafales maximales.
* Frontières départementales redessinées avec précision sous-pixel sur toutes les cartes.
* Isobares renforcées et flèches de vent séparées des isolignes, avec une pointe pleine plus lisible.

= 1.5.1 =
* Capture enrichie avec modèle, paramètre, run, échéance, zone ciblée, zoom, légende complète, source et version.
* Bouton Replier déplacé à côté de Prévision valable et supprimé de l’en-tête du menu.
* Diagnostic orage entièrement recalculé : la MUCAPE seule ne produit plus de faux risque.
* Ajout du taux de précipitation IFS au diagnostic convectif et libellé Nul lorsque le signal est absent.

= 1.5.0 =
* Croix cartographique moderne et bouton Replier du menu rendu plus visible.
* Remplacement de Figer la valeur par Copier l’image dans le presse-papiers.
* Capture PNG recomposée hors du tampon WebGL pour supprimer les images noires.
* Cumuls de précipitations calculés entre deux curseurs de période.
* Nouvelle carte Rafales maximales calculée sur la période choisie.
* Instabilité et Relief regroupés sous Pression ; libellé Altitude du relief simplifié.

= 1.4.0 =
* Vraies isobares de pression tous les 4 hPa sur Vent moyen et Rafales.
* Flèches redessinées à taille constante, avec halo clair et placement décalé des isobares.
* Limites départementales IGN détaillées à 25 % en remplacement du fond simplifié à 5 %.
* Une seule surcouche vectorielle partagée entre Vent moyen et Rafales pour éviter tout ancien tracé résiduel.

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
