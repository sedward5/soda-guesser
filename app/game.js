const MAX_GUESSES = 6;
const STORAGE_PREFIX = "pop-quiz-v2";

// The first game in games.json is played on this date.
// Games then advance sequentially through the dataset and loop.
const DAILY_EPOCH = "2026-10-06";

const elements = {
  canvas: document.querySelector("#game-canvas"),
  imageFrame: document.querySelector("#image-frame"),
  placeholder: document.querySelector("#image-placeholder"),
  form: document.querySelector("#guess-form"),
  input: document.querySelector("#guess-input"),
  button: document.querySelector("#guess-button"),
  message: document.querySelector("#guess-message"),
  guesses: document.querySelector("#guesses"),
  progress: document.querySelector("#progress-label"),
  clarity: document.querySelector("#clarity-label"),
  result: document.querySelector("#result"),
  resultKicker: document.querySelector("#result-kicker"),
  resultTitle: document.querySelector("#result-title"),
  resultDetail: document.querySelector("#result-detail"),
  share: document.querySelector("#share-button"),
  date: document.querySelector("#date-label"),
  help: document.querySelector("#help-button"),
  dialog: document.querySelector("#help-dialog"),
  helpClose: document.querySelector("#help-close"),
  freePlay: document.querySelector("#free-play-button"),
  modeLabel: document.querySelector("#mode-label"),
  suggestions: document.querySelector("#guess-suggestions"),
};

const ctx = elements.canvas.getContext("2d");

let games = [];
let puzzle = null;
let sourceImage = null;
let guesses = [];
let finished = false;
let won = false;
let mode = "daily";


/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedTokens(value) {
  return normalize(value)
    .split(" ")
    .filter(Boolean);
}

function compactCharacters(value) {
  return normalize(value).replace(/ /g, "");
}


/* -------------------------------------------------------------------------- */
/* Date / daily puzzle                                                        */
/* -------------------------------------------------------------------------- */

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function dateDifferenceInDays(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);

  return Math.floor(
    (to - from) / (1000 * 60 * 60 * 24),
  );
}

function dailyIndex(dateKey, count) {
  if (!count) return 0;

  const daysSinceEpoch = dateDifferenceInDays(
    DAILY_EPOCH,
    dateKey,
  );

  return ((daysSinceEpoch % count) + count) % count;
}


/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

function storageKey() {
  if (mode === "free") {
    return `${STORAGE_PREFIX}:free`;
  }

  return `${STORAGE_PREFIX}:daily:${localDateKey()}`;
}

function saveState() {
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        puzzleId: puzzle?.id || null,
        guesses,
        finished,
        won,
      }),
    );
  } catch {
    // Local storage is optional.
  }
}

function loadState() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey()) || "null",
    );

    if (!saved) return false;

    // Don't accidentally restore Free Play state against
    // a different randomly selected puzzle.
    if (
      mode === "free" &&
      saved.puzzleId &&
      saved.puzzleId !== puzzle?.id
    ) {
      return false;
    }

    guesses = Array.isArray(saved.guesses)
      ? saved.guesses
      : [];

    finished = Boolean(saved.finished);
    won = Boolean(saved.won);

    return true;
  } catch {
    return false;
  }
}

function clearCurrentState() {
  guesses = [];
  finished = false;
  won = false;

  try {
    localStorage.removeItem(storageKey());
  } catch {
    // Ignore storage failures.
  }
}


/* -------------------------------------------------------------------------- */
/* Answer matching                                                            */
/* -------------------------------------------------------------------------- */

function answerNames(game) {
  return [
    game.name,
    ...(game.aliases || []),
    ...(game.accept || []),
  ]
    .map(normalize)
    .filter(Boolean);
}

function hasMeaningfulWordOverlap(first, second) {
  const firstTokens = normalizedTokens(first);
  const secondTokens = normalizedTokens(second);

  if (!firstTokens.length || !secondTokens.length) {
    return false;
  }

  const secondSet = new Set(secondTokens);

  // Exact word overlap is particularly useful for:
  //
  //   Mario
  //   Mario Kart
  //
  // and:
  //
  //   Call of Duty
  //   Call of Duty Black Ops
  //
  const sharedWords = firstTokens.filter(
    token => secondSet.has(token),
  );

  if (!sharedWords.length) {
    return false;
  }

  // Very short generic words such as "the", "of", etc. shouldn't
  // independently trigger a partial.
  const meaningful = sharedWords.filter(
    token => token.length >= 3,
  );

  return meaningful.length > 0;
}

function hasStrongPrefixOverlap(first, second) {
  const firstTokens = normalizedTokens(first);
  const secondTokens = normalizedTokens(second);

  if (!firstTokens.length || !secondTokens.length) {
    return false;
  }

  const shorter = firstTokens.length <= secondTokens.length
    ? firstTokens
    : secondTokens;

  const longer = firstTokens.length <= secondTokens.length
    ? secondTokens
    : firstTokens;

  // A title beginning with the same meaningful words is a strong
  // series/title relationship.
  if (shorter.length > longer.length) {
    return false;
  }

  for (let index = 0; index < shorter.length; index += 1) {
    if (shorter[index] !== longer[index]) {
      return false;
    }
  }

  return shorter.some(token => token.length >= 4);
}

function levenshteinDistance(first, second) {
  const a = compactCharacters(first);
  const b = compactCharacters(second);

  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from(
    { length: b.length + 1 },
    (_, index) => index,
  );

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= b.length; j += 1) {
      const insertion = current[j - 1] + 1;
      const deletion = previous[j] + 1;
      const substitution =
        previous[j - 1] +
        (a[i - 1] === b[j - 1] ? 0 : 1);

      current.push(
        Math.min(
          insertion,
          deletion,
          substitution,
        ),
      );
    }

    for (let j = 0; j < current.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function editSimilarity(first, second) {
  const a = compactCharacters(first);
  const b = compactCharacters(second);

  if (!a.length || !b.length) {
    return 0;
  }

  const distance = levenshteinDistance(a, b);
  const longest = Math.max(a.length, b.length);

  return 1 - distance / longest;
}

function isPartialMatch(guess, game) {
  const normalizedGuess = normalize(guess);

  if (!normalizedGuess) {
    return false;
  }

  return answerNames(game).some(answer => {
    if (normalizedGuess === answer) {
      return false;
    }

    const guessLength =
      compactCharacters(normalizedGuess).length;

    const answerLength =
      compactCharacters(answer).length;

    // Short answers need much stronger evidence.
    //
    // This is the important fix for:
    //
    //   Reel
    //   Pokémon FireRed
    //
    // where four shared characters used to produce a false partial.
    if (
      Math.min(guessLength, answerLength) < 5
    ) {
      return (
        hasMeaningfulWordOverlap(
          normalizedGuess,
          answer,
        ) ||
        hasStrongPrefixOverlap(
          normalizedGuess,
          answer,
        )
      );
    }

    if (
      hasMeaningfulWordOverlap(
        normalizedGuess,
        answer,
      )
    ) {
      return true;
    }

    if (
      hasStrongPrefixOverlap(
        normalizedGuess,
        answer,
      )
    ) {
      return true;
    }

    // Character-level similarity is now only a fallback.
    // Require strong edit similarity and reasonably sized titles.
    return (
      Math.min(guessLength, answerLength) >= 6 &&
      editSimilarity(
        normalizedGuess,
        answer,
      ) >= 0.72
    );
  });
}

function guessStatus(value) {
  const normalized = normalize(value);

  if (answerNames(puzzle).includes(normalized)) {
    return "correct";
  }

  if (isPartialMatch(normalized, puzzle)) {
    return "partial";
  }

  return "wrong";
}


/* -------------------------------------------------------------------------- */
/* Images                                                                     */
/* -------------------------------------------------------------------------- */

function selectedImage(game) {
  const usable = (game.images || []).filter(
    image => image.path,
  );

  if (!usable.length) return null;

  // First logical image for v1.
  return usable[0];
}

function clarityForGuessCount(count) {
  const levels = [
    ["Very pixelated", 12],
    ["Heavily pixelated", 20],
    ["Pixelated", 32],
    ["Getting recognizable", 48],
    ["Mostly clear", 80],
    ["Clear", 160],
  ];

  return levels[
    Math.min(count, levels.length - 1)
  ];
}

function drawPixelated(forceClear = false) {
  if (!sourceImage) return;

  const width =
    elements.canvas.clientWidth || 800;

  const height =
    elements.canvas.clientHeight || 450;

  const dpr = Math.min(
    window.devicePixelRatio || 1,
    2,
  );

  elements.canvas.width =
    Math.round(width * dpr);

  elements.canvas.height =
    Math.round(height * dpr);

  ctx.clearRect(
    0,
    0,
    elements.canvas.width,
    elements.canvas.height,
  );

  const targetRatio = width / height;

  const sourceRatio =
    sourceImage.naturalWidth /
    sourceImage.naturalHeight;

  let sx = 0;
  let sy = 0;
  let sw = sourceImage.naturalWidth;
  let sh = sourceImage.naturalHeight;

  if (sourceRatio > targetRatio) {
    sw =
      sourceImage.naturalHeight *
      targetRatio;

    sx =
      (sourceImage.naturalWidth - sw) /
      2;
  } else {
    sh =
      sourceImage.naturalWidth /
      targetRatio;

    sy =
      (sourceImage.naturalHeight - sh) /
      2;
  }

  if (forceClear) {
    ctx.imageSmoothingEnabled = true;

    ctx.drawImage(
      sourceImage,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      elements.canvas.width,
      elements.canvas.height,
    );

    return;
  }

  const pixelSize =
    clarityForGuessCount(
      guesses.length,
    )[1];

  let smallWidth;
  let smallHeight;

  if (targetRatio >= 1) {
    smallHeight = pixelSize;
    smallWidth = Math.max(
      8,
      Math.round(pixelSize * targetRatio),
    );
  } else {
    smallWidth = pixelSize;
    smallHeight = Math.max(
      8,
      Math.round(pixelSize / targetRatio),
    );
  }

  const temp =
    document.createElement("canvas");

  temp.width = smallWidth;
  temp.height = smallHeight;

  const tempCtx =
    temp.getContext("2d");

  tempCtx.imageSmoothingEnabled = true;

  tempCtx.drawImage(
    sourceImage,
    sx,
    sy,
    sw,
    sh,
    0,
    0,
    smallWidth,
    smallHeight,
  );

  ctx.imageSmoothingEnabled = false;

  ctx.drawImage(
    temp,
    0,
    0,
    smallWidth,
    smallHeight,
    0,
    0,
    elements.canvas.width,
    elements.canvas.height,
  );
}


/* -------------------------------------------------------------------------- */
/* Guess UI                                                                   */
/* -------------------------------------------------------------------------- */

function statusLabel(status) {
  switch (status) {
    case "correct":
      return "🟩 Correct";

    case "partial":
      return "🟨 Close";

    default:
      return "⬜ Wrong";
  }
}

function statusDetail(status) {
  switch (status) {
    case "correct":
      return "You found it.";

    case "partial":
      return "That looks like a related title.";

    default:
      return "Not this one.";
  }
}

function renderGuesses() {
  elements.guesses.innerHTML = "";

  for (
    let index = 0;
    index < MAX_GUESSES;
    index += 1
  ) {
    const guess = guesses[index];

    const row =
      document.createElement("li");

    if (!guess) {
      row.className = "guess-row empty";

      row.innerHTML = `
        <span class="guess-name">—</span>
        <span class="guess-status">Waiting</span>
        <span class="attempt">
          ${index + 1}/${MAX_GUESSES}
        </span>
      `;

      elements.guesses.appendChild(row);
      continue;
    }

    const status =
      guessStatus(guess);

    row.className =
      `guess-row ${status}`;

    row.innerHTML = `
      <span class="guess-name">
        ${escapeHtml(guess)}
      </span>
      <span class="guess-status">
        ${statusLabel(status)}
        <small>
          ${statusDetail(status)}
        </small>
      </span>
      <span class="attempt">
        ${index + 1}/${MAX_GUESSES}
      </span>
    `;

    elements.guesses.appendChild(row);
  }

  elements.progress.textContent =
    finished
      ? won
        ? `Solved in ${guesses.length}`
        : "Game over"
      : `Guess ${
          guesses.length + 1
        } of ${MAX_GUESSES}`;

  elements.clarity.textContent =
    clarityForGuessCount(
      guesses.length,
    )[0];
}

function escapeHtml(value) {
  const div =
    document.createElement("div");

  div.textContent = value;

  return div.innerHTML;
}

function setMessage(
  message,
  isError = false,
) {
  elements.message.textContent =
    message;

  elements.message.classList.toggle(
    "error",
    isError,
  );
}

function flash(
  element,
  className,
) {
  if (!element) return;

  element.classList.remove(
    className,
  );

  void element.offsetWidth;

  element.classList.add(
    className,
  );
}


/* -------------------------------------------------------------------------- */
/* Game completion                                                            */
/* -------------------------------------------------------------------------- */

function finishGame(success) {
  finished = true;
  won = success;

  elements.input.disabled = true;
  elements.button.disabled = true;

  if (success) {
    drawPixelated(true);
  }

  elements.result.hidden = false;
  elements.result.classList.add("pop");

  if (success) {
    elements.resultKicker.textContent =
      mode === "free"
        ? "Nice one"
        : "Nice one";

    elements.resultTitle.textContent =
      puzzle.name;

    elements.resultDetail.textContent =
      `You got it in ${
        guesses.length
      } ${
        guesses.length === 1
          ? "guess"
          : "guesses"
      }.`;
  } else {
    elements.resultKicker.textContent =
      mode === "free"
        ? "Try another"
        : "Better luck tomorrow";

    elements.resultTitle.textContent =
      puzzle.name;

    elements.resultDetail.textContent =
      `The answer was ${puzzle.name}.`;
  }

  saveState();
  renderGuesses();
}


/* -------------------------------------------------------------------------- */
/* Guess submission                                                           */
/* -------------------------------------------------------------------------- */

function submitGuess(value) {
  const guess = value.trim();

  if (!guess || finished) return;

  const normalized =
    normalize(guess);

  if (
    guesses.some(
      existing =>
        normalize(existing) ===
        normalized,
    )
  ) {
    setMessage(
      "You already tried that.",
      true,
    );

    flash(
      elements.input,
      "shake",
    );

    return;
  }

  const status =
    guessStatus(guess);

  guesses.push(guess);

  elements.input.value = "";

  drawPixelated();
  renderGuesses();

  const latestRow =
    elements.guesses[
      guesses.length - 1
    ];

  flash(
    latestRow,
    "pop",
  );

  if (status === "correct") {
    finishGame(true);
    return;
  }

  if (guesses.length >= MAX_GUESSES) {
    finishGame(false);
    return;
  }

  if (status === "partial") {
    setMessage(
      "🟨 Close! You're in the right neighborhood.",
    );
  } else {
    setMessage(
      "⬜ Nope. The picture just got a little clearer.",
    );
  }

  saveState();
  elements.input.focus();
}


/* -------------------------------------------------------------------------- */
/* Autocomplete                                                               */
/* -------------------------------------------------------------------------- */

function populateSuggestions() {
  if (!elements.suggestions) return;

  elements.suggestions.innerHTML = "";

  const names = [
    ...new Set(
      games
        .map(game => game.name)
        .filter(Boolean),
    ),
  ];

  names.forEach(name => {
    const option =
      document.createElement("option");

    option.value = name;

    elements.suggestions.appendChild(
      option,
    );
  });
}

function updateAutocomplete() {
  if (!elements.input) return;

  const value =
    elements.input.value.trim();

  elements.input.setAttribute(
    "list",
    value.length >= 3
      ? "guess-suggestions"
      : "",
  );
}


/* -------------------------------------------------------------------------- */
/* Sharing                                                                    */
/* -------------------------------------------------------------------------- */

function shareResult() {
  const blocks =
    guesses
      .map(guess => {
        switch (
          guessStatus(guess)
        ) {
          case "correct":
            return "🟩";

          case "partial":
            return "🟨";

          default:
            return "⬜";
        }
      })
      .join("");

  const text =
    `Pop Quiz ${
      mode === "free"
        ? "Free Play"
        : localDateKey()
    }\n` +
    `${blocks}\n` +
    `${
      won
        ? `${guesses.length}/6`
        : "X/6"
    }\n` +
    "https://sedward5.github.io/soda-guesser/";

  if (navigator.share) {
    navigator
      .share({
        title: "Pop Quiz",
        text,
      })
      .catch(() => {});

    return;
  }

  navigator.clipboard
    ?.writeText(text)
    .then(() => {
      setMessage(
        "Result copied to your clipboard.",
      );
    })
    .catch(() => {
      setMessage(text);
    });
}


/* -------------------------------------------------------------------------- */
/* Image loading                                                              */
/* -------------------------------------------------------------------------- */

function loadImage(path) {
  return new Promise(
    (resolve, reject) => {
      const image =
        new Image();

      image.onload = () => {
        resolve(image);
      };

      image.onerror = () => {
        reject(
          new Error(
            `Could not load image: ${path}`,
          ),
        );
      };

      image.src = path;
    },
  );
}


/* -------------------------------------------------------------------------- */
/* Puzzle selection                                                           */
/* -------------------------------------------------------------------------- */

function selectDailyPuzzle() {
  const key =
    localDateKey();

  const index =
    dailyIndex(
      key,
      games.length,
    );

  return games[index];
}

function selectFreePuzzle() {
  if (!games.length) {
    return null;
  }

  // Avoid immediately replaying the same game when possible.
  const previousId =
    puzzle?.id;

  const candidates =
    games.filter(
      game =>
        game.id !== previousId,
    );

  const pool =
    candidates.length
      ? candidates
      : games;

  const index =
    Math.floor(
      Math.random() * pool.length,
    );

  return pool[index];
}


/* -------------------------------------------------------------------------- */
/* UI mode                                                                    */
/* -------------------------------------------------------------------------- */

function updateModeUI() {
  if (elements.modeLabel) {
    elements.modeLabel.textContent =
      mode === "free"
        ? "Free Play"
        : "Today's Game";
  }

  if (elements.freePlay) {
    elements.freePlay.textContent =
      mode === "free"
        ? "Another Game"
        : "Free Play";
  }

  elements.date.textContent =
    mode === "free"
      ? "Random game"
      : localDateKey();
}


/* -------------------------------------------------------------------------- */
/* Start a puzzle                                                             */
/* -------------------------------------------------------------------------- */

async function startPuzzle(nextPuzzle, nextMode) {
  if (!nextPuzzle) return;

  mode = nextMode;
  puzzle = nextPuzzle;
  sourceImage = null;

  guesses = [];
  finished = false;
  won = false;

  elements.input.disabled = false;
  elements.button.disabled = false;

  elements.input.value = "";

  elements.result.hidden = true;
  elements.result.classList.remove("pop");

  elements.placeholder.hidden = false;
  elements.placeholder.textContent =
    "Loading…";

  updateModeUI();
  renderGuesses();

  const image =
    selectedImage(puzzle);

  if (!image) {
    throw new Error(
      "This game has no usable image.",
    );
  }

  sourceImage =
    await loadImage(
      image.path,
    );

  elements.placeholder.hidden =
    true;

  drawPixelated();
  renderGuesses();

  setMessage(
    "What game is this?",
  );

  elements.input.focus();
}


/* -------------------------------------------------------------------------- */
/* Load daily game                                                            */
/* -------------------------------------------------------------------------- */

async function loadGame() {
  try {
    setMessage(
      "Loading today's game…",
    );

    const response =
      await fetch(
        "data/games.json",
        {
          cache: "no-store",
        },
      );

    if (!response.ok) {
      throw new Error(
        `Could not load game data (HTTP ${response.status}).`,
      );
    }

    const data =
      await response.json();

    games =
      Array.isArray(data.games)
        ? data.games
        : [];

    if (!games.length) {
      throw new Error(
        "No games were found in the dataset.",
      );
    }

    populateSuggestions();

    mode = "daily";
    puzzle =
      selectDailyPuzzle();

    const image =
      selectedImage(puzzle);

    if (!image) {
      throw new Error(
        "Today's game has no usable image.",
      );
    }

    // Load saved daily state.
    loadState();

    sourceImage =
      await loadImage(
        image.path,
      );

    elements.placeholder.hidden =
      true;

    updateModeUI();

    drawPixelated();
    renderGuesses();

    if (finished) {
      elements.result.hidden =
        false;

      elements.resultKicker.textContent =
        won
          ? "Already solved"
          : "Today's answer";

      elements.resultTitle.textContent =
        puzzle.name;

      elements.resultDetail.textContent =
        won
          ? `You solved it in ${
              guesses.length
            } ${
              guesses.length === 1
                ? "guess"
                : "guesses"
            }.`
          : "Come back tomorrow for a new game.";

      if (won) {
        drawPixelated(true);
      }
    } else {
      setMessage(
        "What game is this?",
      );

      elements.input.focus();
    }
  } catch (error) {
    console.error(
      "Pop Quiz failed to load:",
      error,
    );

    elements.placeholder.hidden =
      false;

    elements.placeholder.textContent =
      "Couldn't load today's game.";

    setMessage(
      "Try refreshing the page.",
      true,
    );
  }
}


/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

elements.form.addEventListener(
  "submit",
  event => {
    event.preventDefault();

    submitGuess(
      elements.input.value,
    );
  },
);

elements.input.addEventListener(
  "input",
  updateAutocomplete,
);

elements.share.addEventListener(
  "click",
  shareResult,
);

elements.help.addEventListener(
  "click",
  () =>
    elements.dialog.showModal(),
);

elements.helpClose.addEventListener(
  "click",
  () =>
    elements.dialog.close(),
);

elements.dialog.addEventListener(
  "click",
  event => {
    if (
      event.target ===
      elements.dialog
    ) {
      elements.dialog.close();
    }
  },
);

if (elements.freePlay) {
  elements.freePlay.addEventListener(
    "click",
    async () => {
      try {
        const nextPuzzle =
          selectFreePuzzle();

        if (!nextPuzzle) return;

        await startPuzzle(
          nextPuzzle,
          "free",
        );
      } catch (error) {
        console.error(
          "Could not start free play:",
          error,
        );

        setMessage(
          "Couldn't start another game.",
          true,
        );
      }
    },
  );
}

window.addEventListener(
  "resize",
  () => {
    window.requestAnimationFrame(
      () =>
        drawPixelated(
          finished && won,
        ),
    );
  },
);


/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

loadGame();
