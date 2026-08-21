"use strict";
/* Taxonomie de catégories par défaut (reprise de la structure du classeur comptable
   d'origine) et liste de comptes de départ. Modifiable ensuite dans l'application. */

const CATS_SORTIE = [
 {id:1,name:"Remboursement cotisation",subs:[{id:11,name:"Remboursement cotisation"}]},
 {id:2,name:"Dépenses fédérales",subs:[{id:21,name:"Licences fédérales"},{id:22,name:"Cotisations USL"},{id:23,name:"Engagements compét. départ."},{id:24,name:"Engagements compét. région"},{id:25,name:"Engagements compét. nation"},{id:26,name:"Cotisations fédérales"},{id:27,name:"Amendes, pénalités"}]},
 {id:3,name:"Dépenses d'arbitrage",subs:[{id:31,name:"Frais d'arbitrage département"},{id:32,name:"Frais d'arbitrage région"},{id:33,name:"Frais d'arbitrage nation"}]},
 {id:4,name:"Dépenses spécifiques",subs:[{id:41,name:"Assurance sport loisir"}]},
 {id:5,name:"Equipements",subs:[{id:51,name:"Achat matériel collectif"},{id:52,name:"Equipements"},{id:53,name:"Entretien matériels"}]},
 {id:6,name:"Educateurs sportifs",subs:[{id:61,name:"Salaires"},{id:62,name:"Charges sociales"},{id:63,name:"Honoraires personnel ext."},{id:64,name:"Prestations services USL"},{id:65,name:"Quasi bénévoles"},{id:66,name:"Formations"},{id:67,name:"Médecine du travail"},{id:68,name:"Prime de match"}]},
 {id:7,name:"Indemnités de déplacement",subs:[{id:71,name:"Déplacement salariés"},{id:72,name:"Déplacement entraînement/match joueurs"},{id:73,name:"Déplacement bénévoles"}]},
 {id:8,name:"Frais généraux",subs:[{id:81,name:"Location annuelle"},{id:82,name:"Sacem PRE"},{id:83,name:"Pharmacie"},{id:84,name:"Abonnements magazine"},{id:85,name:"Frais secrétariat"},{id:86,name:"Lavage de maillots"},{id:87,name:"Publicités, annonces"}]},
 {id:10,name:"Déplacement sportif",subs:[{id:101,name:"Déplacement sportif départ."},{id:102,name:"Déplacement sportif région"},{id:103,name:"Déplacement sportif nation"}]},
 {id:11,name:"Manifestations sportives",subs:[{id:111,name:"Tournois"},{id:112,name:"Stages"}]},
 {id:12,name:"Dépenses extra sportives",subs:[{id:121,name:"Buvettes"},{id:122,name:"Boisson après match"},{id:123,name:"Animations"}]},
 {id:13,name:"Partenariat",subs:[{id:131,name:"Support (panneaux)"},{id:132,name:"Redevance sponsoring"}]},
 {id:14,name:"Charges financières",subs:[{id:141,name:"Charges financières"},{id:142,name:"Déplacement Trésorerie Vive"}]},
 {id:15,name:"Charges exceptionnelles",subs:[{id:151,name:"Charges sur exercices antérieurs"},{id:152,name:"Événements familiaux/exceptionnels"},{id:153,name:"Dons effectués"},{id:154,name:"Remboursement avance USL"},{id:155,name:"Pénalités URSSAF"}]},
 {id:16,name:"Charges groupement",subs:[{id:161,name:"Charges groupement/entente"}]}
];
const CATS_ENTREE = [
 {id:1,name:"Cotisations membres",subs:[{id:11,name:"Cotisations des membres"}]},
 {id:2,name:"Remboursements fédéraux",subs:[{id:21,name:"Remboursement fédéral"},{id:22,name:"Rembst arbitrage régional"},{id:23,name:"Rembst arbitrage national/internat."},{id:24,name:"Rembst fédéral/membre"}]},
 {id:3,name:"Subventions",subs:[{id:31,name:"CNDS"},{id:32,name:"Subvention fonctionnement USL"},{id:33,name:"Subv. municipale exceptionnelle"},{id:34,name:"Subventions départementales"},{id:35,name:"Subv. municipale région"},{id:36,name:"Subv. municipale nation/internation"},{id:37,name:"Subvention fédérale"}]},
 {id:5,name:"Equipements",subs:[{id:51,name:"Recettes équipements"}]},
 {id:6,name:"Educateurs sportifs",subs:[{id:61,name:"Indemnités journalières"}]},
 {id:7,name:"Recettes formations",subs:[{id:71,name:"Participation aux frais de formation"}]},
 {id:8,name:"Recettes compétitions",subs:[{id:81,name:"Billetterie matchs"},{id:82,name:"Prime coupe"},{id:83,name:"Autres"}]},
 {id:11,name:"Manifestations sportives",subs:[{id:111,name:"Tournois, semi, trail, gala, spectacle"},{id:112,name:"Stages jeunes"}]},
 {id:12,name:"Ressources extra sportives",subs:[{id:121,name:"Buvettes"},{id:122,name:"Animations"},{id:123,name:"Divers ressources extra-sportives"}]},
 {id:13,name:"Partenariat",subs:[{id:131,name:"Publicité, parrainage, sponsoring"}]},
 {id:14,name:"Produits financiers",subs:[{id:141,name:"Produits financiers"},{id:142,name:"Produits Trésorerie Vive"}]},
 {id:15,name:"Produits exceptionnels",subs:[{id:151,name:"Dons reçus, membres bienfaiteurs"},{id:152,name:"Chèques >1an non débités"},{id:153,name:"Avances trésoreries USL"}]},
 {id:16,name:"Produits groupement",subs:[{id:161,name:"Recettes groupement/entente"}]}
];
const ACCOUNTS_DEFAULT = [
 {id:1,name:"Compte courant",opening:0},
 {id:2,name:"Caisse",opening:0},
 {id:3,name:"Trésorerie vive",opening:0},
 {id:4,name:"Compte livret",opening:0},
 {id:5,name:"Chèques non débités",opening:0}
];

module.exports = {
  meta: { club: "USL Section Basket", saison: "2025-2026", seasonStartYear: 2025 },
  accounts: ACCOUNTS_DEFAULT,
  categories: { sortie: CATS_SORTIE, entree: CATS_ENTREE },
  budget: { sortie: {}, entree: {} },
  refs: { fournisseurs: [], salaries: [], evenements: [] },
  anomalySettings: { seuilHaut: 10000, seuilBas: 0 }
};
