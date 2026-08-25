# CEP / ECMWF IFS France — cartes et prévisions WordPress

Ce dépôt construit une chaîne directe **ECMWF Open Data IFS 0,25° → GitHub Actions → WordPress/Avada**. Il publie les cartes interactives et les prévisions de 34 746 communes françaises sur une branche `data`, sans intermédiaire météorologique.

## Production

- modèle déterministe IFS, couramment appelé CEP en France ;
- grille ouverte 0,25° (environ 28 km) ;
- runs principaux 00 UTC et 12 UTC ;
- échéances toutes les 3 h jusqu'à +144 h, puis toutes les 6 h jusqu'à +240 h ;
- température, point de rosée, humidité, vent, rafales, pression, pluie, neige, nuages et CAPE selon disponibilité dans les produits ouverts ;
- cartes WebP interactives, valeur sous la souris et prévisions par commune.

Les données IFS Open Data sont en GRIB2 et publiées sous licence CC BY 4.0. Aucune clé API ECMWF n'est nécessaire.

## Installation GitHub

1. Copiez tout le contenu de cette archive à la racine du dépôt `alertesmeteo-hub/cep`.
2. Dans **Settings → Actions → General → Workflow permissions**, activez **Read and write permissions**.
3. Lancez **Actions → Mise à jour CEP France → Run workflow**.
4. Vérifiez ensuite la branche `data` et son fichier `index.json`.

Commande locale équivalente :

```bash
python -m pip install -r requirements.txt
python scripts/update_cep_france.py \
  --catalog config/communes-france.json \
  --output-dir build/national \
  --forecast-hours 240
```

## Installation WordPress

Installez le ZIP séparé `cep-ecmwf-france-v1.0.0.zip`, activez-le, puis utilisez :

```text
[cep_meteo]
```

Exemple :

```text
[cep_meteo ville="Paris" code="75056" departement="75" heures="240"]
```

L'URL de données par défaut est :

```text
https://raw.githubusercontent.com/alertesmeteo-hub/cep/data
```

## Sources

- [ECMWF Open Data](https://www.ecmwf.int/en/forecasts/datasets/open-data)
- [Client officiel ecmwf-opendata](https://github.com/ecmwf/ecmwf-opendata)
- API Découpage administratif de la République française pour la recherche des communes

Site : [www.alertes-meteo.com](https://www.alertes-meteo.com/) — module v1.0.0.
