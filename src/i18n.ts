import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

export const SUPPORTED_LANGUAGES = ['fr', 'en'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const LANGUAGE_STORAGE_KEY = 'motiontwin-ports:v1:language';

const resources = {
  fr: {
    translation: {
      document: {
        title: 'Ports KadoKado',
      },
      language: {
        label: 'Langue',
        fr: 'FR',
        en: 'EN',
      },
      nav: {
        play: 'Jouer',
        scores: 'Scores',
        about: 'À propos',
      },
      site: {
        topBar: 'Projet amateur de préservation - jouez tout de suite',
        buildTitle: 'Portage',
        gamesOnline: '{{count}} jeux en ligne',
        noAccount: 'Aucun compte requis',
        statusTitle: 'État',
        portsPlayable: 'Ports jouables',
        aboutProject: 'Le projet',
        scoresTitle: 'Scores',
        recordsUseScores: 'Les records viennent des scores sauvegardés',
        viewScores: 'Voir les scores',
        footer: 'Projet amateur de préservation - jeux originaux par Motion Twin',
      },
      landing: {
        notice: "Ports jouables, reconstruits avec les ressources d'origine quand elles sont disponibles",
      },
      record: {
        empty: 'Record: -',
        value: 'Record: {{score}}',
      },
      actions: {
        play: 'jouer',
        help: 'aide',
      },
      pages: {
        aboutTitle: 'À propos',
        aboutIntro:
          'Ce site est un projet amateur de préservation autour de jeux Motion Twin et KadoKado jouables dans le navigateur. Les ports utilisent TypeScript et PixiJS, avec les ressources originales extraites quand elles sont disponibles.',
        aboutScope:
          "Le site garde l'esthétique du portail 2005-2006, sans inventer de comptes, cadeaux, forums, clans, publicités ou fonctions de plateforme qui n'existent pas.",
        scoresTitle: 'Scores',
        loadingScores: 'Chargement des scores',
        noScores: 'Aucun score pour le moment',
      },
      player: {
        score: 'Score',
        best: 'Record',
        bestMetric: 'Meilleur {{label}}',
        saveScore: 'Enregistrer le score',
        pseudonym: 'Pseudo',
        pseudonymPlaceholder: 'Nom',
        save: 'Enregistrer',
        leaderboard: 'Classement',
        back: 'Retour aux jeux',
        playAgain: 'Rejouer',
        restart: 'Recommencer',
        retry: 'Réessayer',
        status: {
          loading: 'Chargement',
          starting: 'Démarrage',
          saving: 'Enregistrement',
          newBest: 'Nouveau record',
          saved: 'Score enregistré',
          ended: 'Partie terminée',
          playing: 'En jeu',
          unableToStart: 'Impossible de lancer',
        },
        loadingLeaderboard: 'Chargement du classement',
        noScores: 'Aucun score pour le moment',
      },
      metrics: {
        height: 'Hauteur',
        difficulty: 'Difficulté',
      },
      errors: {
        invalidJson: 'Le serveur a renvoyé une réponse invalide.',
        loadLeaderboard: 'Impossible de charger le classement.',
        invalidLeaderboard: 'Le serveur a renvoyé un classement invalide.',
        saveScore: "Impossible d'enregistrer le score.",
        invalidScoreResponse: 'Le serveur a renvoyé une réponse de score invalide.',
        leaderboardUnavailable: 'Classement indisponible.',
        scoresUnavailable: 'Scores indisponibles.',
        startGame: 'Impossible de lancer ce jeu.',
        loadGame: 'Impossible de charger ce jeu.',
        pseudonymRequired: 'Le pseudo est obligatoire.',
        pseudonymUnsupported: 'Le pseudo contient des caractères non pris en charge.',
        pseudonymTooLong: 'Le pseudo doit faire 24 caractères ou moins.',
        invalidScore: 'Le score doit être un entier positif ou nul.',
        rateLimited: 'Trop de scores envoyés. Réessayez plus tard.',
        crossOrigin: 'Les scores externes ne sont pas acceptés.',
        invalidBody: 'La requête doit être un objet JSON.',
        unknownGame: 'Jeu inconnu.',
        internalServer: 'Erreur interne du serveur.',
      },
      games: {
        interwheel: {
          title: 'Interwheel',
          description:
            "Au secours c'est l'inondation, aidez Krakra la petite tache de crasse à s'évader de la salle de bain du temple aztèque Tenochtitlan, attention aux mines ancestrales du grand Quetzal !",
          help: "Un seul bouton pour bondir de roue en roue. Évitez les mines et l'eau qui monte, et grimpez le plus haut possible.",
        },
        pioupiou: {
          title: 'Pioupiou',
          description: 'Aidez le pauvre Piou-Piou tombé dans cet affreux piège digne des plus machiavéliques écraseurs de poussins.',
          help: 'Déplacez-vous avec les flèches. Grimpez sur les blocs, ramassez les pièces et évitez de vous faire écraser.',
        },
        manda: {
          title: 'Manda',
          description: 'Tortillez-vous pour ramasser les fruits et les bonus, tentez de survivre longtemps et surtout évitez les murs ! Un grand classique.',
          help: 'Dirigez le serpent avec gauche et droite, accélérez avec haut, ramassez fruits et bonus, et évitez les murs ainsi que votre queue.',
        },
        killbulle: {
          title: 'Kill Bulle',
          description:
            'Retrouvez Kanji le Ninja dans une nouvelle aventure ! Utilisez le grapin de façon à détruire les bulles bondissantes et gagnez ainsi un max de points.',
          help: "Déplacez Kanji avec les flèches. Lancez le grapin avec espace pour diviser les bulles avant qu'elles ne vous touchent.",
        },
        linea: {
          title: 'Linea',
          description: "Tracez les lignes les plus longues possible, composez les bonus et tentez de garder le rythme jusqu'au dernier point lumineux.",
          help: 'Tracez des chemins entre les points compatibles. Les longues lignes et les multiplicateurs font grimper le score.',
        },
        alphabounce: {
          title: 'Alphabounce',
          description: "Rebondissez dans l'espace, cassez les blocs et survivez aux événements qui transforment chaque niveau en pluie de lettres.",
          help: 'Contrôlez la raquette, cassez les blocs-lettres, attrapez les bonus utiles et survivez à chaque vague.',
        },
        kslash: {
          title: 'K-Slash !',
          description:
            'Kanji est en infiltration au pays des bambous ! Débarrassez-vous de ses encombrantes tortues belliqueuses grâce à vos shuriken et votre sabre.',
          help: 'Bougez, sautez, tranchez et lancez des kunai pour nettoyer les ennemis et avancer dans les bambous.',
        },
        'iron-chouquette': {
          title: 'Iron Chouquette',
          description:
            "La patrouille des lapins-robots a kidnappé Chouquette ! Retrouvez-la avant qu'il ne soit trop tard dans le tournoi interstellaire d'Andromède.",
          help: "Esquivez les tirs, ramassez les bonus et tenez bon pendant le boss rush sans perdre le contrôle de l'arène.",
        },
      },
    },
  },
  en: {
    translation: {
      document: {
        title: 'KadoKado Ports',
      },
      language: {
        label: 'Language',
        fr: 'FR',
        en: 'EN',
      },
      nav: {
        play: 'Play',
        scores: 'Scores',
        about: 'About',
      },
      site: {
        topBar: 'Fan preservation project - play instantly',
        buildTitle: 'Build',
        gamesOnline: '{{count}} games online',
        noAccount: 'No account required',
        statusTitle: 'Status',
        portsPlayable: 'Ports playable',
        aboutProject: 'About project',
        scoresTitle: 'Scores',
        recordsUseScores: 'Records use saved scores',
        viewScores: 'View scores',
        footer: 'Fan preservation project - original games by Motion Twin',
      },
      landing: {
        notice: 'Playable ports, rebuilt with original assets where available',
      },
      record: {
        empty: 'Record: -',
        value: 'Record: {{score}}',
      },
      actions: {
        play: 'play',
        help: 'help',
      },
      pages: {
        aboutTitle: 'About',
        aboutIntro:
          'This is a fan preservation project for playable Motion Twin and KadoKado-era browser games. The ports use TypeScript and PixiJS, with original extracted assets where available.',
        aboutScope:
          'The website keeps the 2005-2006 portal aesthetic, but avoids fake accounts, prizes, forums, clans, ads, and platform features that are not implemented.',
        scoresTitle: 'Scores',
        loadingScores: 'Loading scores',
        noScores: 'No scores yet',
      },
      player: {
        score: 'Score',
        best: 'Best',
        bestMetric: 'Best {{label}}',
        saveScore: 'Save score',
        pseudonym: 'Pseudonym',
        pseudonymPlaceholder: 'Name',
        save: 'Save',
        leaderboard: 'Leaderboard',
        back: 'Back to games',
        playAgain: 'Play again',
        restart: 'Restart',
        retry: 'Retry',
        status: {
          loading: 'Loading',
          starting: 'Starting',
          saving: 'Saving score',
          newBest: 'New best',
          saved: 'Score saved',
          ended: 'Run ended',
          playing: 'Playing',
          unableToStart: 'Unable to start',
        },
        loadingLeaderboard: 'Loading leaderboard',
        noScores: 'No scores yet',
      },
      metrics: {
        height: 'Height',
        difficulty: 'Difficulty',
      },
      errors: {
        invalidJson: 'The server returned invalid JSON.',
        loadLeaderboard: 'Could not load leaderboard.',
        invalidLeaderboard: 'The server returned an invalid leaderboard.',
        saveScore: 'Could not save score.',
        invalidScoreResponse: 'The server returned an invalid score response.',
        leaderboardUnavailable: 'Leaderboard unavailable.',
        scoresUnavailable: 'Scores unavailable.',
        startGame: 'Could not start this game.',
        loadGame: 'Could not load this game.',
        pseudonymRequired: 'Pseudonym is required.',
        pseudonymUnsupported: 'Pseudonym contains unsupported characters.',
        pseudonymTooLong: 'Pseudonym must be 24 characters or fewer.',
        invalidScore: 'Score must be a non-negative integer.',
        rateLimited: 'Too many score submissions. Try again later.',
        crossOrigin: 'Cross-origin score submissions are not accepted.',
        invalidBody: 'Request body must be a JSON object.',
        unknownGame: 'Unknown game.',
        internalServer: 'Internal server error.',
      },
      games: {
        interwheel: {
          title: 'Interwheel',
          description:
            "The flood is coming! Help Krakra, the little stain, escape the flooded bathroom of the Aztec temple Tenochtitlan. Watch out for Quetzal's ancient mines!",
          help: 'Use one button to jump from wheel to wheel. Avoid mines and rising water while climbing as high as possible.',
        },
        pioupiou: {
          title: 'Pioupiou',
          description: 'Help poor Piou-Piou, trapped in a terrible pit built by the most devious chick crushers.',
          help: 'Move with the arrow keys. Climb falling blocks, collect coins, and avoid getting crushed.',
        },
        manda: {
          title: 'Manda',
          description: 'Wiggle around to collect fruit and bonuses, survive as long as you can, and above all avoid the walls. A true classic.',
          help: 'Steer with left and right, accelerate with up, collect fruit and bonuses, and avoid the walls and your tail.',
        },
        killbulle: {
          title: 'Kill Bulle',
          description: 'Kanji the Ninja is back in a new adventure. Use the grappling hook to burst bouncing bubbles and score as many points as you can.',
          help: 'Move with the arrow keys. Fire the grappling hook with space to split bubbles before they touch Kanji.',
        },
        linea: {
          title: 'Linea',
          description: 'Trace the longest lines you can, build bonuses, and keep the rhythm until the final glowing dot.',
          help: 'Draw paths through matching dots. Longer lines and multipliers are the key to a strong score.',
        },
        alphabounce: {
          title: 'Alphabounce',
          description: 'Bounce through space, break the blocks, and survive events that turn each level into a storm of letters.',
          help: 'Control the paddle, break letter blocks, catch useful bonuses, and survive each event wave.',
        },
        kslash: {
          title: 'K-Slash !',
          description: 'Kanji is infiltrating the bamboo lands. Clear out troublesome turtles with shuriken and sword strikes, or flatten them underfoot.',
          help: 'Move, jump, slash, and throw kunai to clear enemies while pushing through the bamboo stages.',
        },
        'iron-chouquette': {
          title: 'Iron Chouquette',
          description: 'Robot-rabbits have kidnapped Chouquette! Find her before it is too late in the interstellar Andromeda tournament.',
          help: 'Dodge bullet patterns, collect bonuses, and push through the boss rush without losing control of the arena.',
        },
      },
    },
  },
} as const;

export async function initI18n(): Promise<void> {
  await i18next.use(LanguageDetector).init({
    resources,
    supportedLngs: SUPPORTED_LANGUAGES,
    fallbackLng: 'en',
    load: 'languageOnly',
    returnNull: false,
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: [],
    },
  });
  applyDocumentLanguage();
}

export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

export function currentLanguage(): SupportedLanguage {
  return i18next.resolvedLanguage === 'fr' ? 'fr' : 'en';
}

export async function setLanguage(language: SupportedLanguage): Promise<void> {
  await i18next.changeLanguage(language);
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Private browsing / quota failures should not block language switching.
  }
}

export function onLanguageChanged(callback: () => void): void {
  i18next.on('languageChanged', () => {
    applyDocumentLanguage();
    callback();
  });
}

export function formatLocalizedNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(currentLanguage(), {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
  }).format(value);
}

export function metricLabel(key: string, fallback: string): string {
  return t(`metrics.${key}`, { defaultValue: fallback });
}

function applyDocumentLanguage(): void {
  document.documentElement.lang = currentLanguage();
  document.title = t('document.title');
}
