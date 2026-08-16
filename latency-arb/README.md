# Arbitrage de latence — BTC spot vs Polymarket

Moteur qui compare en continu le prix du Bitcoin sur Binance et Coinbase aux
probabilites affichees par les marches Bitcoin de Polymarket, et qui prend
position quand le carnet Polymarket n'a pas encore integre un mouvement du spot.

Aucune vue directionnelle sur le BTC. La seule question posee est :
**le carnet a-t-il deja vu ce qui vient de se passer ?**

---

## D'abord, la mise au point qui compte

L'histoire des « 218 000 $ en 10 jours » circule sans preuve verifiable.
Ce qui est reel, c'est le **mecanisme** : le decalage entre un marche spot qui
cote en continu et un marche de prediction qui se re-cote plus lentement existe
bel et bien, et il est exploitable. Ce qui est douteux, c'est le **rendement
annonce**. Trois raisons :

1. **Les gains publies sont un survivant.** Personne ne publie les portefeuilles
   qui ont fondu. Sur 354 operations, une bonne serie de chance est banale.
2. **Ce creneau est deja tres dispute.** Le retard de Polymarket sur un
   mouvement BTC se compte en centaines de millisecondes a quelques secondes.
   Des acteurs colocalises le prennent avant toi. Ta latence reelle depuis un
   ordinateur domestique (30-300 ms de reseau, plus le temps de signature de
   l'ordre) mange l'essentiel de la fenetre.
3. **La marge affichee n'est pas la marge encaissee.** Il faut traverser le
   spread, subir la disparition de la liquidite pendant ton aller-retour, et
   parfois rester coince dans une position quand le retard n'etait qu'un
   desaccord de modele.

Ce projet implemente le mecanisme proprement, avec les garde-fous, et te donne
les outils pour **mesurer toi-meme** si la marge existe encore a ta latence —
au lieu de le croire sur parole.

---

## Ce que fait le moteur

Trois conditions doivent tenir **ensemble** pour ouvrir une position :

| # | Condition | Ce que ca verifie |
|---|-----------|-------------------|
| 1 | **Impulsion** | Le juste prix implique par le spot a bouge d'au moins `MIN_IMPULSE` sur `LAG_WINDOW_MS` |
| 2 | **Non-absorption** | Le carnet Polymarket n'a pas suivi ce mouvement, et son sommet est fige depuis `MIN_BOOK_STALENESS_MS` |
| 3 | **Marge** | Apres spread, frais, impact et incertitude du modele, il reste `MIN_EDGE` |

La condition 2 est le coeur du systeme. Sans elle, un ecart entre le modele et
le marche serait traite comme une opportunite — alors qu'un desaccord persistant
signifie presque toujours que **c'est le modele qui a tort**.

La sortie suit la meme logique : on sort quand le marche s'est realigne
(retard consomme), pas quand le pari devient gagnant. Une regle dediee ferme
toute position dont le carnet a repris la main sans que la marge revienne :
c'est le moment ou un arbitrage degenere en pari directionnel.

### Valorisation

Pour un marche « BTC au-dessus de K a l'echeance T », la probabilite juste est
celle d'un digital sous mouvement brownien geometrique **sans derive** :

```
P = N(d2),  d2 = [ ln(S/K) − σ²τ/2 ] / (σ√τ)
```

La derive est volontairement nulle : parier sur la direction du BTC n'est pas la
strategie. σ est la volatilite realisee (moyenne mobile exponentielle des
log-rendements), **echantillonnee sur une grille d'une seconde** — echantillonner
a chaque tick mesure le bruit de microstructure et surestime σ d'un facteur deux
ou plus, ce qui ecrase tous les justes prix vers 0,5.

Les marches a barriere (« Bitcoin atteindra-t-il X ? ») sont **rejetes** : leur
payoff depend du chemin, `N(d2)` y est faux.

---

## Resultats mesures (simulation)

Le simulateur genere un BTC synthetique (diffusion + sauts) et un carnet
Polymarket qui suit la juste valeur **avec un retard configurable**. La latence
d'execution du moteur est fixee a 350 ms, sa perte de file d'attente a 50 %.

12 sessions d'une heure par ligne, capital 1 000 USDC, plafond 100 USDC par marche :

| Retard du carnet | Operations | Reussite | Resultat median | Pire session | Sessions gagnantes | Duree moyenne |
|---|---|---|---|---|---|---|
| 5 000 ms | 173 | 85,0 % | +31,86 | +7,27 | 12/12 | 11 s |
| 3 000 ms | 102 | 79,4 % | +16,83 | −13,68 | 10/12 | 22 s |
| 1 500 ms | 33 | 66,7 % | +10,23 | −20,27 | 7/12 | 70 s |
| 750 ms | 14 | 71,4 % | 0,00 | −10,69 | 5/12 | 59 s |
| **350 ms** | 3 | 0,0 % | 0,00 | −20,38 | 0/12 | 333 s |
| **0 ms** | 2 | 0,0 % | 0,00 | −19,24 | 0/12 | 253 s |

Deux lectures, et la seconde est la plus importante :

- **Le moteur fait ce qu'on lui demande.** Quand le retard existe, il le detecte,
  le prend, et sort en quelques secondes.
- **La marge meurt quand le retard du marche descend au niveau de ta propre
  latence.** A 350 ms de retard contre 350 ms de latence : plus rien. C'est la
  loi physique de ce creneau, et aucun reglage ne la contourne.

Reproduis-le : `npm run sim -- --lag=1500 --runs=12 --compare`

Ces chiffres **ne sont pas une prevision de rendement**. Le simulateur suppose
un retard constant, une liquidite stable et aucun concurrent. Le marche reel
n'offre aucune des trois. La ligne « 0 ms » est le test de controle : une
strategie qui gagnerait aussi sans retard ne ferait pas de l'arbitrage.

---

## Installation

```bash
cd latency-arb
node --version        # 22 ou plus (WebSocket natif, aucune dependance)
cp .env.example .env
npm test
```

Aucune dependance npm en mode papier. Le mode reel en ajoute deux (voir plus bas).

## Utilisation

```bash
npm run sim -- --lag=1500 --runs=12 --compare   # hors ligne, aucun reseau
npm run scan                                    # liste les marches exploitables
npm run paper                                   # temps reel, execution simulee
npm run record                                  # idem, en journalisant les flux
npm run replay -- ./data/session.ndjson         # rejoue la seance enregistree
```

Le tableau de bord est sur <http://127.0.0.1:8787> (positions, marges, motifs de
rejet). Il n'ecoute que sur la boucle locale.

**La sequence recommandee** : `sim` pour comprendre le comportement, puis
`record` pendant plusieurs jours, puis `replay` pour regler les seuils sur des
donnees vraies. Regler les seuils sur le simulateur revient a s'entrainer contre
sa propre imagination.

---

## Architecture

```
src/
  config.js              Configuration + validation de coherence au demarrage
  engine.js              Assemblage : flux -> strategie -> risque -> execution
  dashboard.js           Supervision HTTP locale
  portfolio.js           Positions, resultat, statistiques
  feeds/
    socket.js            WebSocket avec reconnexion et backoff
    binance.js           bookTicker + aggTrade
    coinbase.js          canal ticker
    spot.js              Prix consolide, exclusion des flux figes, volatilite
  polymarket/
    parse.js             Normalisation des marches, rejet des cas non valorisables
    discovery.js         Decouverte via l'API Gamma, seuil des marches up/down
    book.js              Carnets CLOB : instantane REST + deltas WebSocket
  model/
    pricer.js            Digital N(d2), sensibilite au spot
    costs.js             Frais preneur min(p, 1-p)
  strategy/
    latency-arb.js       Impulsion, non-absorption, marge, dimensionnement
    token-view.js        Vue YES/NO, vrai carnet ou complement synthetique
  risk/limits.js         Plafonds, coupe-circuits
  exec/
    paper.js             Execution simulee avec latence et perte de file
    live.js              Execution reelle, verrouillee par defaut
  replay/                Simulateur, enregistreur, rejeu
```

66 tests couvrent la valorisation, le carnet, la detection de retard, les
plafonds de risque et la comparaison retard / sans retard : `npm test`.

---

## Ce qui n'a pas pu etre verifie ici

Le bac a sable de developpement bloque `api.binance.com`,
`ws-feed.exchange.coinbase.com`, `gamma-api.polymarket.com` et
`clob.polymarket.com` (refus 403 du mandataire reseau). Consequence directe :

- **Verifie et teste** : valorisation, detection de retard, dimensionnement,
  plafonds de risque, execution simulee, rejeu, boucle complete sur marche
  synthetique.
- **Ecrit d'apres la documentation, jamais execute contre les serveurs reels** :
  les quatre connecteurs (flux Binance, flux Coinbase, decouverte Gamma, carnets
  CLOB). Le format des messages suit la documentation publique, mais lance
  `npm run scan` puis `npm run paper` **avant** toute autre chose, et verifie que
  les seuils, echeances et carnets affiches correspondent bien a ce que montre
  le site de Polymarket.

Un point merite une verification manuelle systematique : pour les marches
« Up or Down », le seuil est reconstruit depuis l'ouverture de la bougie horaire
Binance. **Si Polymarket resout ces marches sur une autre source de prix**, un
ecart de quelques dollars suffit a inverser le signe de la marge. Lis la regle de
resolution du marche avant de l'exploiter.

---

## Mode reel

Il est verrouille par defaut et le restera tant que tu n'auras pas fourni deux
drapeaux explicites :

```bash
LIVE_TRADING=1
LIVE_CONFIRM="JE COMPRENDS LES RISQUES"
npm install @polymarket/clob-client ethers
```

Le module `exec/live.js` ne reimplemente pas la signature EIP-712 des ordres : il
delegue au client officiel. Ecrire soi-meme cette signature est le meilleur moyen
de perdre des fonds sur une erreur de domaine ou de nonce.

Avant d'y toucher :

- **Verifie la legalite dans ta juridiction.** Polymarket est bloque ou restreint
  dans plusieurs pays — la France notamment, ou l'ANJ a fait bloquer l'acces, et
  les Etats-Unis pour les residents. Contourner un blocage geographique te fait
  perdre tout recours en cas de probleme sur tes fonds.
- **Utilise un portefeuille dedie**, jamais ton portefeuille principal. La cle
  privee vit dans un fichier `.env` sur ta machine.
- **Commence a `BANKROLL=50`.** Les plafonds par defaut (100 USDC par marche,
  250 d'exposition, 100 de perte journaliere) sont faits pour etre reduits, pas
  augmentes.
- **Le coupe-circuit journalier ne se rearme pas tout seul.** S'il se declenche,
  c'est un signal : relis le journal avant de relancer.

Enfin : ce depot est un outil de mesure et d'apprentissage, pas un conseil en
investissement. La perte totale du capital engage est un resultat possible.
