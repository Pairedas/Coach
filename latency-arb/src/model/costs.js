/**
 * Modele de couts d'un aller-retour sur Polymarket.
 *
 * Les frais preneur suivent la forme historique de Polymarket :
 * frais = taux x min(p, 1-p) x taille. Le taux par defaut est 0 (aucun frais
 * sur la plupart des marches), mais il est configurable car il a deja change.
 */
export function takerFee(price, shares, feeBps) {
  if (!feeBps) return 0;
  return (feeBps / 10_000) * Math.min(price, 1 - price) * shares;
}

/**
 * Cout total par action pour un aller-retour : frais d'entree + frais de sortie
 * estimes au prix de sortie attendu. Exprime en unites de probabilite, donc
 * directement comparable a une marge.
 */
export function roundTripCostPerShare({ entryPrice, expectedExitPrice, feeBps }) {
  const inFee = takerFee(entryPrice, 1, feeBps);
  const outFee = takerFee(expectedExitPrice, 1, feeBps);
  return inFee + outFee;
}
