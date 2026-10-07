const MAX_GUESSES = 6;
const STORAGE_PREFIX = "pop-quiz-v1";

// The first game in games.json is played on this date.
// Games then advance sequentially through the dataset and loop.
const DAILY_EPOCH = "2026-10-06";

// A simple, intentionally forgiving partial-match threshold.
// Exact matches are always checked first.
const PARTIAL_THRESHOLD = 0.60;

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
};

const ctx = elements.canvas.getContext("2d");

let games = [];
let puzzle = null;
let sourceImage = null;
let guesses = [];
let finished = false;
let won = false;

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

function compactCharacters(value) {
  return normalize(value).replace(/ /g, "");
}

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

  // JavaScript's % can return a negative number,
  // so normalize it back into the valid array range.
  return ((daysSinceEpoch % count) + count) % count;
}

function storageKey() {
  return `${STORAGE_PREFIX}:${localDateKey()}`;
}

function saveState() {
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        guesses,
        finished,
        won,
      }),
    );
  } catch {
    // Local storage is optional. The game should still work without it.
  }
}

function loadState() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey()) || "null",
    );

    if (!saved) return;

    guesses = Array.isArray(saved.guesses)
      ? saved.guesses
      : [];

    finished = Boolean(saved.finished);
    won = Boolean(saved.won);
  } catch {
    // A corrupted local state should never prevent the game from loading.
  }
}

function answerNames(game) {
  return [
    game.name,
    ...(game.aliases || []),
    ...(game.accept || []),
  ].map(normalize);
}

function sharedCharacterRatio(first, second) {
  const a = compactCharacters(first);
  const b = compactCharacters(second);

  if (!a.length || !b.length) return 0;

  // Count each character so repeated letters matter.
  // Example: "Mario" and "Mario Kart" share all five
  // characters from "Mario", making them a useful partial.
  const counts = new Map();

  for (const character of a) {
    counts.set(
      character,
      (counts.get(character) || 0) + 1,
    );
  }

  let shared = 0;

  for (const character of b) {
    const available = counts.get(character) || 0;

    if (available > 0) {
      shared += 1;
      counts.set(character, available - 1);
    }
  }

  return shared / Math.min(a.length, b.length);
}

function isPartialMatch(guess, game) {
  const normalizedGuess = normalize(guess);

  return answerNames(game).some(
    answer =>
      normalizedGuess !== answer &&
      sharedCharacterRatio(
        normalizedGuess,
        answer,
      ) >= PARTIAL_THRESHOLD,
  );
}

function guessStatus(value) {
  const normalized = normalize(value);

  // Exact matches always win.
  if (answerNames(puzzle).includes(normalized)) {
    return "correct";
  }

  // Partial matching is deliberately simple:
  // 60%+ shared characters with an answer title.
  if (isPartialMatch(normalized, puzzle)) {
    return "partial";
  }

  return "wrong";
}

function selectedImage(game) {
  const usable = (game.images || []).filter(
    image => image.path,
  );

  if (!usable.length) return null;

  // Use the first logical image for v1.
  // The schema intentionally supports multiple images.
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

  // Crop the source image to the same aspect ratio as the game frame.
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

  // On a correct answer, reveal the actual image.
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

  // The second value represents the number of pixels
  // across the short dimension of the reduced image.
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

  // Smooth while reducing the image.
  // Then disable smoothing when scaling it back up.
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

function statusLabel(status) {
  switch (status) {
    case "correct":
      return "Correct";

    case "partial":
      return "Partial";

    default:
      return "Wrong";
  }
}

function renderGuesses() {
  elements.guesses.innerHTML = "";

  guesses.forEach((guess, index) => {
    const status = guessStatus(guess);

    const row =
      document.createElement("li");

    row.className =
      `guess-row ${status}`;

    row.innerHTML = `
      <span class="guess-name">
        ${escapeHtml(guess)}
      </span>
      <span class="guess-status">
        ${statusLabel(status)}
      </span>
      <span class="attempt">
        ${index + 1}/${MAX_GUESSES}
      </span>
    `;

    elements.guesses.appendChild(row);
  });

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

function finishGame(success) {
  finished = true;
  won = success;

  elements.input.disabled = true;
  elements.button.disabled = true;

  // A correct answer gets the full-resolution reveal.
  if (success) {
    drawPixelated(true);
  }

  elements.result.hidden = false;
  elements.result.classList.add("pop");

  if (success) {
    elements.resultKicker.textContent =
      "Nice one";

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

    setMessage("🟩 Correct!");
  } else {
    elements.resultKicker.textContent =
      "Better luck tomorrow";

    elements.resultTitle.textContent =
      puzzle.name;

    elements.resultDetail.textContent =
      `The answer was ${puzzle.name}.`;

    setMessage(
      "⬜ No more guesses.",
    );
  }

  saveState();
  renderGuesses();
}

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

  // Every guess reveals a little more.
  drawPixelated();
  renderGuesses();

  const latestRow =
    elements.guesses.lastElementChild;

  flash(latestRow, "pop");

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
    `Pop Quiz ${localDateKey()}\n` +
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

    const key =
      localDateKey();

    // Deterministic sequential daily selection.
    //
    // With the current five-game dataset:
    // Oct 6 -> game 1
    // Oct 7 -> game 2
    // Oct 8 -> game 3
    // Oct 9 -> game 4
    // Oct 10 -> game 5
    // Oct 11 -> game 1 again
    const index =
      dailyIndex(
        key,
        games.length,
      );

    puzzle = games[index];

    const image =
      selectedImage(puzzle);

    if (!image) {
      throw new Error(
        "Today's game has no usable image.",
      );
    }

    // Load saved state BEFORE rendering.
    loadState();

    sourceImage =
      await loadImage(
        image.path,
      );

    elements.placeholder.hidden =
      true;

    elements.date.textContent =
      localDateKey();

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

      // If the player already solved today's puzzle,
      // show the clear image again.
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

elements.form.addEventListener(
  "submit",
  event => {
    event.preventDefault();

    submitGuess(
      elements.input.value,
    );
  },
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

window.addEventListener(
  "resize",
  () => {
    window.requestAnimationFrame(
      () => drawPixelated(finished && won),
    );
  },
);

loadGame();
