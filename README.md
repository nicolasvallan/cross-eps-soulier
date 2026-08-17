# Application CROSS EPS

Première version responsive utilisable sur ordinateur, tablette et téléphone.

## Fonctions incluses

- Gestion des élèves
- Import CSV et Excel (.xlsx/.xls)
- Attribution automatique des dossards
- Création des courses
- Affectation des participants
- Chronomètre commun
- Validation de points de passage
- Gestion de l'arrivée par clic sur dossard
- Réintégration d'un dossard en course
- Correction manuelle du temps
- Classement automatique
- Vitesse moyenne, allure, meilleur temps
- Classement par classe
- Export CSV
- Génération des dossards A5 (2 par feuille A4) avec impression / enregistrement PDF
- Deux logos configurables : collège et association
- Sauvegarde / restauration JSON
- Données enregistrées localement dans le navigateur

## Lancement simple

### Option 1 - VS Code
Ouvrir le dossier dans VS Code et lancer `index.html` avec l'extension **Live Server**.

### Option 2 - Python
Dans un terminal ouvert dans ce dossier :

```bash
python -m http.server 8000
```

Puis ouvrir :

```text
http://localhost:8000
```

## Format CSV conseillé

Utiliser de préférence le séparateur `;`.

```text
Nom;Prénom;Date de naissance;Genre;Classe;Dossard
MARTIN;Léa;2013-04-10;F;5A;101
DUPONT;Hugo;2013-07-21;M;5A;102
```

Les colonnes obligatoires sont :
- Nom
- Prénom
- Date de naissance
- Classe

Genre et Dossard sont optionnels.

## Limite de cette V1

Cette version fonctionne hors ligne et stocke les informations **sur l'appareil utilisé**.

Si plusieurs appareils doivent travailler simultanément sur la même course (ex. téléphone au point de passage + tablette à l'arrivée + ordinateur de supervision), une V2 devra ajouter une synchronisation réseau/base de données.

## Import Excel

L'import Excel utilise SheetJS chargé depuis son CDN officiel. Une connexion Internet est nécessaire lors du chargement de ce module dans cette version.

## Numéros de dossard

- Les dossards sont affichés sur au moins 3 chiffres : `1` devient `001`, `25` devient `025`, `100` reste `100`.
- Chaque course peut définir une plage réservée, par exemple :
  - 6e filles : `001` à `099`
  - 6e garçons : `100` à `199`
- L'application bloque les plages qui se chevauchent.
- Le bouton **Attribuer les dossards** d'une course répartit automatiquement les numéros disponibles dans sa plage.
- Le bouton **Attribuer selon les courses** permet d'attribuer les dossards pour toutes les courses configurées.


## Sélection automatique des participants

Les participants d'une course sont maintenant sélectionnés automatiquement selon :
- le genre de la course (`F`, `M` ou tous) ;
- l'année de naissance minimum ;
- l'année de naissance maximum.

Exemple : une course `F` avec année minimum `2014` et maximum `2014` sélectionne uniquement les filles nées en 2014.

Les élèves hors critères restent visibles dans la liste et peuvent être cochés exceptionnellement. Ils sont alors enregistrés comme **ajouts manuels**.

## Accents dans les imports

L'import CSV essaie d'abord l'encodage UTF-8 puis Windows-1252, ce qui améliore la lecture des fichiers exportés depuis Excel contenant des caractères comme `é`, `è`, `à`, `ç`, etc.


## Départs groupés

L'application distingue maintenant **catégorie/course** et **départ**.

Exemple :
- 6e filles : `001–099`
- 6e garçons : `100–199`
- primaire filles : `800–899`
- primaire garçons : `900–999`

Vous pouvez créer un départ groupé :
- **6e + primaire filles**
- **6e + primaire garçons**

Les catégories partent avec le même chronomètre mais gardent :
- leurs propres dossards ;
- leurs propres participants ;
- leurs propres résultats ;
- leurs propres classements.

L'écran Arrivée possède aussi un mode **Départ groupé** qui mélange les dossards encore attendus tout en enregistrant chaque élève dans sa bonne catégorie.


## Version 6 — accents et réinitialisation des élèves

### Accents dans les fichiers CSV

La lecture des CSV détecte maintenant plusieurs encodages courants :
- UTF-8 avec ou sans BOM ;
- UTF-16 LE ;
- UTF-16 BE ;
- Windows-1252.

Cela couvre notamment les principaux formats CSV générés par Excel et permet de conserver les caractères comme `é`, `è`, `ê`, `à`, `ç`, `ô`, etc.

### Réinitialiser les élèves

Un bouton **Réinitialiser les élèves** est disponible dans la page Élèves.

Cette action :
- supprime tous les élèves ;
- supprime leurs dossards ;
- supprime leurs résultats et passages ;
- retire les participants des courses ;
- réinitialise les chronomètres.

Les courses, leurs critères, leurs plages de dossards et les départs groupés sont conservés.

Deux confirmations successives sont demandées pour éviter une suppression accidentelle.


## Version 7 — intervalle d'années simplifié

Les deux champs d'année de naissance sont maintenant interprétés comme un intervalle, quel que soit l'ordre de saisie.

Exemples :
- `2014` et `2015` = élèves nés en 2014 ou 2015 ;
- `2015` et `2014` = exactement le même résultat ;
- une seule année renseignée = uniquement cette année.

Le genre continue de s'appliquer en même temps que l'intervalle.


## Version 8 — libellé des années

Dans les paramètres d'une course, les années sont désormais présentées sous la forme :

**Année de naissance comprise entre [année] et [année]**

Exemple : `2014` et `2016` signifie que les élèves nés entre 2014 et 2016 inclus peuvent être sélectionnés selon les autres critères de la course.


## Version 9 — point de passage

Le fonctionnement du point de passage est maintenant identique à celui de l'arrivée :

- lorsqu'un dossard est cliqué, son passage est enregistré ;
- le dossard disparaît immédiatement de la grille ;
- il apparaît dans l'historique du point de passage avec son temps ;
- un bouton **Réintégrer** permet d'annuler le passage en cas d'erreur ;
- après réintégration, le dossard réapparaît dans la grille.

Le suivi est effectué séparément pour chaque nom de point de passage.


## Version 10 — Manifestations, courriers et pièces jointes

Un nouveau module **Manifestations** permet d'archiver les événements EPS.

Pour chaque manifestation, il est possible d'enregistrer :
- le nom ;
- la date ;
- le lieu ;
- l'état (prévue, terminée ou annulée) ;
- l'organisateur / contact ;
- les classes ou publics concernés ;
- une description et des notes.

### Courriers

Chaque manifestation peut contenir un courrier. Des modèles simples sont proposés :
- information aux familles ;
- invitation ;
- demande d'autorisation ;
- courrier libre.

Le bouton **Préremplir le courrier** crée un texte à partir des informations de la manifestation. Le bouton **Imprimer / Enregistrer en PDF** ouvre ensuite la fenêtre d'impression du navigateur.

### Pièces jointes

Des fichiers PDF, Word, Excel, images et autres documents peuvent être joints à une manifestation.

Les fichiers sont stockés localement dans le navigateur via IndexedDB, séparément des élèves et des résultats. Ils peuvent être ouverts/téléchargés depuis la fiche de la manifestation.

**Attention :** la sauvegarde JSON conserve la fiche et la liste des pièces jointes, mais pas le contenu binaire des fichiers. Les pièces jointes restent donc liées à l'appareil/navigateur actuel. Une future version pourra ajouter une sauvegarde complète de l'archive dans un fichier ZIP.


## Version 11 — doubles classements dans les résultats

Les résultats individuels affichent maintenant deux rangs pour chaque élève :

- **Rang course** : position de l'élève parmi tous les arrivants de la course ;
- **Rang classe** : position de l'élève uniquement parmi les élèves de sa classe.

Exemple : un élève peut être affiché **8e / 75 de la course** et **2e de sa classe**.

Un filtre **Classe affichée** permet de n'afficher qu'une classe donnée tout en conservant le rang général de la course.

L'export CSV contient également les colonnes `Rang_course` et `Rang_classe`. Si une classe est filtrée à l'écran, l'export ne contient que cette classe.


## Version 12 — réglage de la taille des dossards

Le module **Dossards** possède maintenant un panneau **Taille des éléments**.

Chaque zone peut être dimensionnée indépendamment :
- numéro de dossard ;
- nom / prénom ;
- classe ;
- nom de la course et distance ;
- nom de l'établissement ;
- texte caritatif ;
- logo du collège ;
- logo de l'association.

Les réglages sont exprimés en pourcentage et l'aperçu est actualisé immédiatement. Les mêmes proportions sont utilisées lors de l'impression ou de l'enregistrement en PDF.

Le bouton **Tailles par défaut** permet de revenir rapidement à 100 % pour tous les éléments.


## Version 13 — Manifestations sous forme de dossiers

Le module **Manifestations** a été simplifié pour correspondre à un fonctionnement d'archive.

Chaque manifestation est maintenant un **dossier d'événement** contenant :
- le nom ;
- la date ;
- le lieu ;
- l'état ;
- le contact ;
- les classes ou publics concernés ;
- des notes ;
- tous les documents nécessaires à l'organisation.

La génération automatique de courriers a été supprimée.

Les courriers sont désormais ajoutés comme n'importe quel autre document déjà existant : PDF, Word, image, etc.

Chaque document peut être classé dans une catégorie :
- Courrier ;
- Autorisation ;
- Organisation ;
- Plan / parcours ;
- Tableau / liste ;
- Résultats ;
- Photo / image ;
- Autre.

Les documents peuvent être ouverts, téléchargés ou retirés depuis le dossier de la manifestation.


## Version 14 — non-partants, abandons et préparation du multi-appareils

Un nouvel écran **Non-partants / abandons** permet de suivre le statut de chaque élève d'une course.

Un participant peut être :
- actif ;
- arrivé ;
- non-partant ;
- abandon.

### Non-partant

Lorsqu'un élève est indiqué comme **Non-partant** :
- il disparaît du point de passage ;
- il disparaît de l'arrivée ;
- ses éventuels passages enregistrés par erreur sont supprimés ;
- il reste visible dans la liste des non-partants ;
- le bouton **Réintégrer** permet de le remettre dans la course.

### Abandon

Lorsqu'un élève est indiqué comme **Abandon** :
- il disparaît des prochains boutons de point de passage ;
- il disparaît de l'arrivée ;
- les passages déjà enregistrés sont conservés ;
- il reste visible dans la liste des abandons ;
- il peut être réintégré en cas d'erreur.

### Utilisation simultanée sur plusieurs appareils

La version actuelle stocke encore les données localement dans le navigateur. Elle ne peut donc pas encore synchroniser réellement trois appareils.

Pour disposer d'un appareil au départ, d'un appareil au point de contrôle et d'un appareil à l'arrivée, la prochaine étape consiste à connecter l'application à une **base de données centrale partagée en temps réel**. Le chronomètre, les statuts, les passages et les arrivées devront alors être enregistrés dans cette base commune afin que chaque appareil voie immédiatement les actions des autres.


## Version 15 — classes concernées par course

Une course peut maintenant être définie à partir de quatre critères :
- le genre ;
- les classes concernées ;
- l'année de naissance minimale ;
- l'année de naissance maximale.

Les classes présentes dans la base élèves apparaissent sous forme de cases à cocher dans la création/modification d'une course.

Cela permet notamment de distinguer deux élèves nés en 2015 :
- un élève de 6e peut être affecté à une course dont les dossards vont de **001 à 099** ;
- un élève de CM2 peut être affecté à une autre course dont les dossards vont de **800 à 899**.

L'attribution automatique des dossards utilise ensuite la plage définie pour chaque course.

Si aucune classe n'est cochée, toutes les classes restent autorisées afin de conserver la compatibilité avec les anciennes courses.


## Version 16 — fonctionnement en course, départs groupés et archives

### Non-partants et abandons pendant la course

Les boutons **Non-partant** et **Abandon** restent disponibles lorsque le chronomètre est déjà lancé.

Le module peut maintenant travailler :
- sur une seule catégorie ;
- sur un **départ groupé**.

Un élève retiré pendant la course disparaît immédiatement du point de contrôle et de l'arrivée.

### Point de passage et départ groupé

Le point de passage possède désormais deux modes :
- une catégorie seule ;
- un départ groupé.

En mode départ groupé, tous les dossards des catégories liées apparaissent dans la même grille. Le temps de passage utilise le chronomètre commun du départ groupé.

### Résultats d'un départ groupé

Les résultats peuvent être affichés pour :
- une catégorie ;
- un départ groupé ;
- une archive.

Pour un départ groupé, l'application affiche :
- le rang dans l'ensemble du départ groupé ;
- le rang dans la catégorie ;
- le rang dans la classe ;
- la catégorie de l'élève.

### Sauvegarde et archives des résultats

Lorsqu'une course ou un départ groupé est arrêté, une **archive automatique** des résultats est créée.

Si la même catégorie est relancée plus tard, l'application :
1. conserve l'ancienne course dans les archives ;
2. efface uniquement les données de la nouvelle manche active ;
3. démarre un nouveau chronomètre sans écraser l'ancienne course.

Le bouton **Sauvegarder les résultats** permet également de créer manuellement une copie supplémentaire à tout moment.

Les archives contiennent les résultats, les statuts non-partant/abandon et les points de passage de la course sauvegardée.


## Version 17 — classement des classes par vitesse moyenne

Dans le tableau **Classement par classe**, la **moyenne des places** a été remplacée par la **vitesse moyenne de course**.

Pour chaque classe, l'application :
- prend les élèves ayant terminé la course ;
- calcule la vitesse de chaque élève à partir de la distance de sa catégorie et de son temps ;
- calcule la moyenne de ces vitesses ;
- classe les classes de la vitesse moyenne la plus élevée à la plus faible.

Cette méthode fonctionne également avec un départ groupé comprenant des catégories de distances différentes, car la vitesse de chaque élève est calculée avec la distance propre à sa catégorie.

La vitesse moyenne est affichée en **km/h** avec deux décimales.


## Version 18 — Firebase et utilisation multi-appareils

Cette version ajoute le socle cloud de CROSS EPS :

- synchronisation Firestore en temps réel entre ordinateurs, tablettes et téléphones ;
- connexion administrateur avec le compte Google autorisé ;
- accès enseignant sans compte personnel grâce à un code temporaire à 6 chiffres ;
- durée configurable du code : 6 h, 12 h ou 24 h ;
- choix du poste enseignant : Départ, Point de passage ou Arrivée ;
- expiration ou fermeture immédiate du code par l'administrateur ;
- indicateur de synchronisation dans la barre supérieure ;
- fusion des modifications concurrentes afin de limiter les écrasements lorsqu'un passage et une arrivée sont enregistrés presque simultanément ;
- sauvegarde locale conservée comme solution de secours ;
- règles Firestore verrouillées : l'administrateur est permanent, les accès enseignants nécessitent une session active.

### Premier démarrage

La première connexion de l'administrateur crée le document de travail Firestore avec les données locales déjà présentes dans le navigateur. Les appareils suivants reçoivent ensuite cette base commune en temps réel.

### Accès enseignant

Dans Paramètres > Accès multi-appareils, l'administrateur génère un code. L'enseignant ouvre l'adresse HTTPS, saisit le code et choisit son poste. Aucun compte Google n'est demandé à l'enseignant.

### Important : pièces jointes des manifestations

Les métadonnées des manifestations sont synchronisées avec l'état général, mais les fichiers binaires ajoutés dans les dossiers de manifestations restent encore dans IndexedDB sur l'appareil d'origine. Une évolution ultérieure vers Firebase Storage sera nécessaire pour partager ces fichiers entre appareils.

### Déploiement

Publier d'abord les règles Firestore et le site avec :

`firebase.cmd deploy`

Le projet est déjà associé à `cross-eps-soulier` dans `.firebaserc`.


## Version 19 — Supabase

Cette version remplace Firebase par Supabase pour la synchronisation multi-appareils.

Configuration intégrée :
- URL Supabase : `https://ksqgcobhkwvjbfpwijgq.supabase.co`
- clé navigateur : clé **publishable** uniquement ;
- aucune clé `service_role` ou clé secrète n'est intégrée.

Avant le premier test :
1. exécuter `supabase-v19-complement.sql` dans le SQL Editor Supabase ;
2. créer dans Authentication le compte administrateur `eps.applicationsnico@gmail.com` avec un mot de passe ;
3. activer les connexions anonymes pour les enseignants ;
4. ouvrir `index.html` avec Live Server.

Cette V19 est destinée au test technique de synchronisation. Avant l'utilisation réelle avec des données d'élèves, les permissions SQL des postes Départ / Passage / Arrivée devront encore être durcies afin de limiter chaque appareil aux seules opérations nécessaires à son rôle.
