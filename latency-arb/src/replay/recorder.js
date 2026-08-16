import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from '../util/log.js';

/**
 * Journal NDJSON d'une session. Rejouer une seance reelle est le seul moyen
 * honnete de tester un changement de parametres : le simulateur montre ce que
 * l'on croit du marche, l'enregistrement montre ce qu'il a vraiment fait.
 */
export class Recorder {
  constructor(filePath) {
    this.filePath = filePath;
    this.log = logger('enregistreur');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.count = 0;
  }

  write(event) {
    this.stream.write(`${JSON.stringify(event)}\n`);
    this.count += 1;
  }

  close() {
    return new Promise((resolve) => {
      this.log.info(`${this.count} evenement(s) ecrit(s) dans ${this.filePath}`);
      this.stream.end(resolve);
    });
  }
}

/** Lit un enregistrement ligne a ligne, sans charger le fichier en memoire. */
export async function* readSession(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Une ligne tronquee (session interrompue) ne doit pas casser le rejeu.
    }
  }
}
