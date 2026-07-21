# grblHAL Studio

**CAM + interface contrôleur pour machines CNC pilotées par grblHAL.**
Le PC prend en charge ce que le microcontrôleur ne peut pas faire : la **compensation de rayon d'outil** (les « courbures », G41/G42 résolues côté PC), le **calcul des vitesses & avances**, le **contrôle des pièces**, et une **interface de pilotage** via Web Serial.

![port](https://img.shields.io/badge/localhost-9107-f5b043) ![stack](https://img.shields.io/badge/stack-Node%20%2B%20vanilla%20JS-4cc9f0)

---

## Pourquoi cet outil

grblHAL gère nativement la **correction de longueur** d'outil (`G43 H`, palpage, table jusqu'à 32 outils) mais **pas** la compensation de **rayon** `G41`/`G42` (le champ `radius` de sa table existe mais est marqué *currently unsupported*). Ce studio comble le manque : il **décale la trajectoire au rayon effectif** (géométrie + usure), gère les coins et détecte les gouges, puis génère un G-code « centre-outil » sûr pour grbl.

## Fonctions

| Domaine | Détail |
|---|---|
| **Table d'outils** | Déclaration Ø / R géométrie + **R usure** / L géométrie + **L usure** / dents / type / matière. Effectif = géométrie + usure. Push `G10 L1` vers grblHAL. |
| **Vitesses & avances** | `N = 1000·Vc/(π·d)`, `Vf = fz·z·N`, base de données matières (ARS/HSS vs carbure), bridage RPM max, ap/ae par stratégie **ébauche / semi-finition / finition**. |
| **Compensation de rayon** | Offset robuste (Clipper) intérieur/extérieur, coins convexes = arcs / concaves = rognage, détection de gouge. |
| **Contrôle des pièces** | Reconstruit la paroi usinée depuis la trajectoire, compare aux cotes nominales, verdict tolérance. |
| **Simulation** | Animation de l'outil le long de la trajectoire (top view), pan/zoom. |
| **Contrôleur** | Web Serial → grblHAL : DRO, jog, home/unlock, cycle start / feed-hold / soft-reset, arrêt d'urgence, console, streaming avec contrôle de flux `ok`. |

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
  tools.js      modèle d'outil (géométrie + usure), persistance, G10 L1
  feeds.js      N, Vf, ap, ae
  geometry.js   parse G-code, aplatissement d'arcs, offset Clipper (cutter comp)
  inspect.js    reconstruction paroi usinée + contrôle tolérance
  grbl.js       driver Web Serial (flux ok, temps réel, jog, status)
  viz.js        rendu canvas 2D + simulation
  app.js        câblage du cockpit
server.js       serveur statique Express (port 9107)
```

## Sécurité machine

- L'arrêt d'urgence envoie un **soft-reset** grblHAL (`0x18`) et vide la file d'envoi.
- La compensation **refuse** un décalage impossible (outil > poche) au lieu de produire un G-code faux.
- Toujours valider par **coupe à vide** puis **coupon mesuré** avant production.

> État firmware : `G41`/`G42` non implémentés dans grblHAL core — la compensation est faite ici, côté PC. La longueur reste native (`G43 H`).
