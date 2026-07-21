# grblHAL Studio

**CAM + interface contrôleur pour machines CNC pilotées par grblHAL.**
Le PC prend en charge ce que le microcontrôleur ne peut pas faire : la **compensation de rayon d'outil** (les « courbures », G41/G42 résolues côté PC), le **calcul des vitesses & avances**, le **contrôle des pièces**, et une **interface de pilotage** via Web Serial.

### ▶ Démo en ligne : **https://thefhiter.github.io/grblhal-studio/**
> À ouvrir dans **Chrome ou Edge**. La CAO (import DXF, compensation, poches, vitesses, contrôle) fonctionne partout ; le **pilotage machine** (Web Serial) exige un contexte sécurisé — la page HTTPS de GitHub Pages convient.

![pages](https://img.shields.io/badge/démo-github.io-1668c0) ![stack](https://img.shields.io/badge/stack-Node%20%2B%20vanilla%20JS-4cc9f0)

---

## Pourquoi cet outil

grblHAL gère nativement la **correction de longueur** d'outil (`G43 H`, palpage, table jusqu'à 32 outils) mais **pas** la compensation de **rayon** `G41`/`G42` (le champ `radius` de sa table existe mais est marqué *currently unsupported*). Ce studio comble le manque : il **décale la trajectoire au rayon effectif** (géométrie + usure), gère les coins et détecte les gouges, puis génère un G-code « centre-outil » sûr pour grbl.

## Fonctions

| Domaine | Détail |
|---|---|
| **Table de correction d'outil** | Grille **éditable** (style gmoccapy/LinuxCNC) : on change chaque nombre en place — T# / poche / Ø / R nez (géométrie + **usure**) / décalage **X en Ø** / longueur Z (géométrie + **usure**) / **direction de pointe 0–9** / dents / désignation. Bascule **Fraisage / Tournage**. « Appliquer » pousse toute la table en `G10 L1` (mill : `P Z R` ; tour : `P X Z R Q`). Palpage : *Mesure face Z* (capture la position machine Z) et *Mesure Ø X* (saisie micromètre) — le geste exact du tip Haas. **Exporter / Importer** toute la table déclarée en **CSV** (ou JSON). |
| **Apparence** | Thème clair « bureau classique » (gris/blanc, à plat) calqué sur ioSender et gmoccapy — pas de mode sombre. |
| **Vitesses & avances** | `N = 1000·Vc/(π·d)`, `Vf = fz·z·N`, base de données matières (ARS/HSS vs carbure), bridage RPM max, ap/ae par stratégie **ébauche / semi-finition / finition**. |
| **Éditeur G-code en direct** | Tape ou colle du G-code → aperçu instantané (ncviewer-style) : trajectoire, gouttière de numéros de ligne, **ligne au curseur surlignée** dans la vue, stats (lignes, mouvements, cadre, longueur de coupe). |
| **Lecture & résolution G41/G42** | L'app **lit la compensation dans le G-code lui-même** (ce que grblHAL ne sait pas faire) : elle détecte chaque zone `G41`/`G42`…`G40`, décale la trajectoire du bon côté au rayon d'outil (arcs aux coins convexes), et affiche **l'arête programmée (bleu) + la trajectoire compensée centre-outil (orange)** avec l'étiquette **intérieur / extérieur** par zone. Rayon lu depuis un indice `D=<Ø>` ou l'outil actif. Exemple : `public/samples/1001.nc`. |
| **Import DXF** | Lecture d'un profil 2D réel (LINE / LWPOLYLINE / POLYLINE / ARC / CIRCLE) : arcs & *bulges* aplatis, segments ouverts recousus en boucles. Le plus grand contour devient compensable ; tous les profils (perçages inclus) sont dessinés. Exemple : `public/samples/demo-part.dxf`. |
| **Compensation de rayon** | Offset robuste (Clipper) intérieur/extérieur, coins convexes = arcs / concaves = rognage, détection de gouge. Le **rayon de nez** de la table pilote directement cette compensation (un R faux = chanfreins qui disparaissent, cf. tip Haas). |
| **Évidement de poche** | Ébauche par passes concentriques (offsets successifs vers l'intérieur au pas radial *ae*), centre→bord, gestion des poches à étranglement. Option « Opération → Poche ». |
| **Décalages pièce** | Éditeur **G54–G59** (repères d'origine pièce) : X/Y/Z éditables, *Position → décalage* (depuis le DRO), *Zéro ici* (`G10 L20`), *Activer*, *Appliquer* (`G10 L2`). Un décalage pièce décale **tous** les outils — le pendant du décalage d'outil (cf. tip Haas). |
| **Contrôle des pièces** | Reconstruit la paroi usinée depuis la trajectoire, compare aux cotes nominales, verdict tolérance. |
| **Simulation** | Animation de l'outil le long de la trajectoire (top view), pan/zoom. |
| **Contrôleur** | Dialogue de connexion type **ioSender** (onglets Série / Réseau, port, baud, action *on connect*). Web Serial → grblHAL : DRO, jog, home/unlock, cycle start / feed-hold / soft-reset, arrêt d'urgence, console, streaming avec contrôle de flux `ok`. |

## Référence : réglage manuel des outils (tour)

La table de correction reprend le déroulé du tip Haas *« Set Your Lathe Offsets Manually »* :
**Ø X** (les X sont en **diamètre** sur un tour ; X0 = axe broche) réglé par *X Diameter Measure* après mesure au micromètre · **Z** (face de la pièce) réglé par *Z Face Measure* · **direction de pointe** (nez d'outil imaginaire, 0–9) : outil de tournage ext. `3`, barre d'alésage `2`, foret `7` · **rayon de nez** lu sur le code plaquette (CNMG 43**2** → .031″ ; CNMG 1204**08** → 0.8 mm). Géométrie = mesuré au réglage (fixe), usure = petite retouche runtime ; effectif = géométrie + usure.

## Démarrage

```bash
npm install
npm start
# → http://localhost:9107   (ouvrir dans Chrome ou Edge)
```

Le pilotage machine utilise l'**API Web Serial** (Chrome/Edge, contexte `localhost` sécurisé). La partie CAO/calcul fonctionne sans machine.

## Architecture

```
public/js/
  materials.js  base Vc + facteurs de stratégie
  tools.js      modèle d'outil (géométrie + usure, X, direction de pointe), G10 L1, TIP_DIRS, CSV
  tooltable.js  grille de correction éditable (Fraisage/Tournage, palpage, sélecteur de pointe)
  wcs.js        décalages pièce G54–G59 (G10 L2 / L20)
  dxf.js        lecteur DXF (LINE/LWPOLYLINE/ARC/CIRCLE → boucles fermées)
  feeds.js      N, Vf, ap, ae
  geometry.js   parse G-code, arcs, offset Clipper (cutter comp + évidement de poche)
  inspect.js    reconstruction paroi usinée + contrôle tolérance
  grbl.js       driver Web Serial (flux ok, temps réel, jog, status, listPorts)
  viz.js        rendu canvas 2D + simulation
  app.js        câblage du cockpit + dialogue de connexion (ioSender-style)
server.js       serveur statique Express (port 9107)
```

## Sécurité machine

- L'arrêt d'urgence envoie un **soft-reset** grblHAL (`0x18`) et vide la file d'envoi.
- La compensation **refuse** un décalage impossible (outil > poche) au lieu de produire un G-code faux.
- Toujours valider par **coupe à vide** puis **coupon mesuré** avant production.

> État firmware : `G41`/`G42` non implémentés dans grblHAL core — la compensation est faite ici, côté PC. La longueur reste native (`G43 H`).
